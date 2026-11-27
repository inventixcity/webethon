import { ApiError, api } from "@/lib/api/client";
import type { AnswerResponse, HeartbeatResult, JournalEntry, JournalSyncResult, Lease, SaveAnswerInput, SaveAnswerResult } from "@/lib/exam/types";
import { JOURNAL_SEQ_BASE, acknowledgeEntries, appendEntry, getMeta, leaseElapsed, listEntries, nextClientSeq, setLease } from "@/lib/exam/journal";
import { attemptHeaders } from "@/lib/exam/device";
import { observeServerTime } from "@/lib/exam/clock";

export type SavedValue = { response: AnswerResponse; flagged: boolean; typing?: SaveAnswerInput["typing"] };
export type SyncCallbacks = { onState?: (state: "saved" | "saving" | "queued" | "offline" | "error") => void; onDeviceActive?: (active: boolean) => void; onClosed?: () => void };
const attemptPath = (id: string, suffix: string) => `/attempts/${encodeURIComponent(id)}/${suffix}` as const;

export async function heartbeat(attemptId: string, pending: number, lastAnnouncementAt: string | null): Promise<HeartbeatResult> {
  const data = await api<HeartbeatResult>(attemptPath(attemptId, "heartbeat"), { body: { online: navigator.onLine, pending, lastAnnouncementAt }, headers: attemptHeaders() });
  observeServerTime(data.serverNow);
  await setLease(attemptId, data.lease);
  return data;
}

function reportConflict(error: unknown, callbacks: SyncCallbacks): void {
  if (error instanceof ApiError && error.status === 409) {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    if (reason === "device") callbacks.onDeviceActive?.(false);
    if (reason === "closed") callbacks.onClosed?.();
  }
}

const syncs = new Map<string, Promise<number>>();
export function syncJournal(attemptId: string, callbacks: SyncCallbacks = {}): Promise<number> {
  const existing = syncs.get(attemptId);
  if (existing) return existing;
  const run = async () => {
    let total = 0;
    try {
      for (;;) {
        const batch = await listEntries(attemptId, 200);
        if (!batch.length) return total;
        callbacks.onState?.("saving");
        const result = await api<JournalSyncResult>(attemptPath(attemptId, "journal"), { body: { entries: batch }, headers: attemptHeaders() });
        // The server head proves earlier entries were committed even if their HTTP response was lost.
        const acknowledged = batch.filter((entry) => entry.seq <= result.seq).map((entry) => entry.seq);
        await acknowledgeEntries(attemptId, acknowledged, result.head, result.seq);
        total += acknowledged.length;
        if (result.rejected.some((entry) => entry.seq > result.seq)) throw new Error(`Journal sync rejected: ${result.rejected.filter((entry) => entry.seq > result.seq).map((entry) => entry.reason).join(", ")}`);
        if (!acknowledged.length) throw new Error("Journal synchronization made no progress.");
      }
    } catch (error) { reportConflict(error, callbacks); throw error; }
  };
  const promise = run().finally(() => { if (syncs.get(attemptId) === promise) syncs.delete(attemptId); });
  syncs.set(attemptId, promise);
  return promise;
}

export async function saveOnline(attemptId: string, itemId: string, value: SavedValue, _callbacks: SyncCallbacks = {}, seq?: number): Promise<SaveAnswerResult> {
  const clientSeq = seq ?? await nextClientSeq(attemptId);
  return api<SaveAnswerResult>(attemptPath(attemptId, `answers/${encodeURIComponent(itemId)}`), { method: "PUT", body: { ...value, clientSeq }, headers: attemptHeaders() });
}

export async function queueOffline(attemptId: string, itemId: string, value: SavedValue, lease: Lease): Promise<JournalEntry> {
  let meta = await getMeta(attemptId);
  if (!meta.lease) { await setLease(attemptId, lease); meta = await getMeta(attemptId); }
  return appendEntry(attemptId, itemId, value.response, value.flagged, meta.lease ?? lease, await leaseElapsed(meta));
}

/** Every edit in offline-enabled attempts enters the durable chain, including online edits.
 * Its PUT uses BASE + journal seq, exactly the sequence used by backend journal replay. This
 * prevents either an old network response or a reconnect from overwriting a newer answer.
 * Written answers debounce only network I/O: their local journal is persisted immediately.
 */
export class AttemptSaveQueue {
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: (send?: boolean) => Promise<void> }>();
  private tasks = new Set<Promise<void>>();
  private failures = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private revisions = new Map<string, number>();
  constructor(private readonly id: string, private readonly options: {
    journalEnabled: boolean; lease: () => Lease | null; offline?: () => boolean;
    onState: (itemId: string, state: "saved" | "saving" | "queued" | "offline" | "error") => void;
    onDeviceActive: (active: boolean) => void; onClosed: () => void;
  }) {}

  enqueue(itemId: string, value: SavedValue, debounceMs = 0): void {
    if (this.stopped) throw new Error("Attempt saves have stopped.");
    const snapshot = structuredClone(value);
    const revision = (this.revisions.get(itemId) ?? 0) + 1;
    this.revisions.set(itemId, revision);
    const report = (state: Parameters<typeof this.options.onState>[1]) => { if (this.revisions.get(itemId) === revision) this.options.onState(itemId, state); };
    report("saving");
    const lease = this.options.lease();
    const prepared = this.options.journalEnabled && lease ? queueOffline(this.id, itemId, snapshot, lease) : Promise.resolve(null);
    void prepared.catch(() => {});
    const old = this.pending.get(itemId);
    if (old) { clearTimeout(old.timer); void old.run(false).catch(() => {}); }
    const callbacks = { onDeviceActive: this.options.onDeviceActive, onClosed: this.options.onClosed };
    const run = (send = true) => {
      this.pending.delete(itemId);
      const task = this.tail.then(async () => {
        const entry = await prepared;
        if (!send && entry) return;
        if (!navigator.onLine || this.options.offline?.()) {
          if (!entry) throw new Error("Answer could not be saved while offline.");
          report("queued"); return;
        }
        try {
          const result = await saveOnline(this.id, itemId, snapshot, {}, entry ? JOURNAL_SEQ_BASE + entry.seq : undefined);
          if (!entry && !result.accepted) throw new Error("The server rejected a stale answer sequence. Reload before continuing.");
          // A heartbeat can replay this exact durable entry before its PUT, making accepted=false.
          if (entry) await syncJournal(this.id, callbacks);
          report("saved");
        } catch (error) {
          reportConflict(error, callbacks);
          if (entry && error instanceof ApiError && (error.status === 0 || (error.status === 409 && (error.details as { reason?: string })?.reason === "closed"))) {
            // At expiry PUT rejects correctly; the journal still admits work written before expiry.
            if (error.status !== 0) await syncJournal(this.id, callbacks);
            report(error.status === 0 ? "queued" : "saved"); return;
          }
          throw error;
        }
      }).then(() => { this.failures.delete(itemId); }, (error: unknown) => {
        this.failures.set(itemId, error); report("error"); throw error;
      });
      this.tail = task.catch(() => {});
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => {});
      return task;
    };
    const timer = setTimeout(() => { void run().catch(() => {}); }, debounceMs);
    this.pending.set(itemId, { timer, run });
  }

  async flush(): Promise<void> {
    const pending = [...this.pending.values()];
    pending.forEach(({ timer }) => clearTimeout(timer));
    await Promise.allSettled(pending.map(({ run }) => run()));
    await Promise.allSettled([...this.tasks]);
    if (this.failures.size) throw this.failures.values().next().value;
  }

  async finalize(finalize: () => Promise<unknown>): Promise<void> {
    this.stopped = true;
    try { await this.flush(); await syncJournal(this.id, { onDeviceActive: this.options.onDeviceActive, onClosed: this.options.onClosed }); await finalize(); }
    catch (error) { this.stopped = false; throw error; }
  }

  dispose(): void { this.stopped = true; for (const { timer, run } of [...this.pending.values()]) { clearTimeout(timer); void run().catch(() => {}); } }
}
