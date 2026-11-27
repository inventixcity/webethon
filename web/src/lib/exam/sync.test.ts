import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEntry, Lease } from "@/lib/exam/types";

const mocks = vi.hoisted(() => ({ api: vi.fn(), append: vi.fn(), list: vi.fn(), acknowledge: vi.fn(), next: vi.fn(), meta: vi.fn(), elapsed: vi.fn(), setLease: vi.fn() }));
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), api: mocks.api }));
vi.mock("@/lib/exam/device", () => ({ attemptHeaders: () => ({ "X-Attempt-Device": "a".repeat(24) }) }));
vi.mock("@/lib/exam/journal", () => ({ JOURNAL_SEQ_BASE: 1_000_000_000, appendEntry: mocks.append, listEntries: mocks.list, acknowledgeEntries: mocks.acknowledge, nextClientSeq: mocks.next, getMeta: mocks.meta, leaseElapsed: mocks.elapsed, setLease: mocks.setLease, cacheAnswer: vi.fn() }));
import { ApiError } from "@/lib/api/client";
import { AttemptSaveQueue, syncJournal } from "@/lib/exam/sync";
import { observeServerTime } from "@/lib/exam/clock";
import { setSimulatedOffline } from "@/lib/exam/network";

const lease: Lease = { attemptId: "attempt", issuedAt: 1_700_000_000_000, deadlineAt: 1_700_000_060_000, mac: "test" };
let entries: JournalEntry[];
let seq: number;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function queue(enabled = true) { return new AttemptSaveQueue("attempt", { journalEnabled: enabled, lease: () => lease, onState: vi.fn(), onDeviceActive: vi.fn(), onClosed: vi.fn() }); }

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("navigator", { onLine: true }); entries = []; seq = 0;
  observeServerTime(new Date(lease.issuedAt).toISOString());
  mocks.meta.mockResolvedValue({ lease }); mocks.elapsed.mockResolvedValue(10); mocks.next.mockImplementation(async () => ++seq);
  mocks.append.mockImplementation(async (_id, itemId, response, flagged) => { const entry = { seq: ++seq, itemId, response, flagged, lease, elapsedMs: 10, writtenAt: lease.issuedAt + 10, hash: `hash-${seq}` }; entries.push(entry); return entry; });
  mocks.list.mockImplementation(async (_id, limit = 200) => entries.slice(0, limit));
  mocks.acknowledge.mockImplementation(async (_id, accepted: number[]) => { entries = entries.filter((entry) => !accepted.includes(entry.seq)); });
  mocks.api.mockImplementation(async (path: string, options: { body: { clientSeq?: number; entries?: JournalEntry[] } }) => path.endsWith("/journal") ? { accepted: options.body.entries?.map((entry) => entry.seq), rejected: [], seq: options.body.entries?.at(-1)?.seq, head: "head" } : { accepted: true, clientSeq: options.body.clientSeq });
});
afterEach(() => { setSimulatedOffline(false); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("submission save barrier", () => {
  it("flushes an 800ms debounce and awaits the in-flight PUT and journal before finalizing", async () => {
    const put = deferred<{ accepted: boolean; clientSeq: number }>();
    const order: string[] = [];
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, options) => { order.push(path); if (path.includes("/answers/")) return put.promise; return base?.(path, options); });
    const saves = queue(); saves.enqueue("item", { response: { text: "The final sentence" }, flagged: false }, 800);
    const finalize = vi.fn(async () => { order.push("finalize"); });
    const submission = saves.finalize(finalize);
    await vi.waitFor(() => expect(order.some((path) => path.includes("/answers/"))).toBe(true));
    expect(finalize).not.toHaveBeenCalled();
    put.resolve({ accepted: true, clientSeq: 1_000_000_001 }); await submission;
    expect(order).toEqual(["/attempts/attempt/answers/item", "/attempts/attempt/journal", "finalize"]);
    expect(entries).toHaveLength(0);
  });

  it("awaits saves already running when submit is clicked", async () => {
    const put = deferred<{ accepted: boolean }>();
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) => path.includes("/answers/") ? put.promise : base?.(path, options));
    const saves = queue(); saves.enqueue("item", { response: { selected: ["a"] }, flagged: false });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
    const finalize = vi.fn(async () => {}); const submission = saves.finalize(finalize);
    await Promise.resolve(); expect(finalize).not.toHaveBeenCalled();
    put.resolve({ accepted: true }); await submission; expect(finalize).toHaveBeenCalledOnce();
  });

  it("rejects on sync failure and retains unacknowledged answers", async () => {
    mocks.api.mockImplementation(async (path) => {
      if (path.endsWith("/journal")) return { accepted: [], rejected: [{ seq: 1, reason: "chain" }], seq: 0, head: null };
      return { accepted: true };
    });
    const saves = queue(); saves.enqueue("item", { response: { text: "Keep me" }, flagged: false }, 800);
    const finalize = vi.fn(); await expect(saves.finalize(finalize)).rejects.toThrow("chain");
    expect(finalize).not.toHaveBeenCalled(); expect(entries).toHaveLength(1);
  });

  it("syncs a pre-deadline answer when expiry has already closed the PUT route", async () => {
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) => {
      if (path.includes("/answers/")) throw new ApiError({ status: 409, code: "CONFLICT", message: "Closed", details: { reason: "closed" } });
      return base?.(path, options);
    });
    const saves = queue(); saves.enqueue("item", { response: { text: "Written in time" }, flagged: false }, 800);
    const finalize = vi.fn(); await saves.finalize(finalize);
    expect(finalize).toHaveBeenCalledOnce(); expect(entries).toHaveLength(0);
  });

  it("never silently finalizes a disabled-journal answer after retrying network failures", async () => {
    vi.useFakeTimers();
    mocks.api.mockRejectedValue(new ApiError({ status: 0, code: "UNAVAILABLE", message: "Network lost" }));
    const saves = queue(false); saves.enqueue("item", { response: { text: "Unsaved" }, flagged: false }, 800);
    const finalize = vi.fn(); const submission = expect(saves.finalize(finalize)).rejects.toThrow("Network lost");
    await vi.advanceTimersByTimeAsync(30_000); await submission;
    expect(finalize).not.toHaveBeenCalled(); expect(mocks.api).toHaveBeenCalledTimes(6); vi.useRealTimers();
  });

  it("debounces written network writes while preserving every local edit", async () => {
    const saves = queue();
    for (const text of ["a", "ab", "abc"]) saves.enqueue("item", { response: { text }, flagged: false }, 800);
    await saves.flush();
    const puts = mocks.api.mock.calls.filter(([path]) => String(path).includes("/answers/"));
    expect(puts).toHaveLength(1); expect(puts[0][1].body.clientSeq).toBe(1_000_000_003);
    expect(mocks.append).toHaveBeenCalledTimes(3); expect(entries).toHaveLength(0);
  });

  it("acknowledges committed prefixes after a lost response and surfaces a genuine stale PUT", async () => {
    entries = [{ seq: 1, itemId: "item", response: { text: "Committed" }, flagged: false, lease, elapsedMs: 0, writtenAt: lease.issuedAt, hash: "hash" }];
    mocks.api.mockResolvedValueOnce({ accepted: [], rejected: [{ seq: 1, reason: "stale" }], seq: 1, head: "hash" });
    await syncJournal("attempt"); expect(entries).toHaveLength(0);
    mocks.api.mockResolvedValue({ accepted: false, clientSeq: 2_000_000_000 });
    const saves = queue(); saves.enqueue("item", { response: { text: "Newer" }, flagged: false }, 800);
    await expect(saves.finalize(vi.fn())).rejects.toThrow("stale answer sequence");
  });

  it("captures a final edit before expiry even when its debounce flushes after expiry", async () => {
    observeServerTime(new Date(lease.deadlineAt - 100).toISOString());
    const saves = queue(); saves.enqueue("item", { response: { text: "Last edit" }, flagged: false }, 800);
    observeServerTime(new Date(lease.deadlineAt + 1000).toISOString());
    await saves.finalize(vi.fn());
    const elapsed = mocks.append.mock.calls[0][5] as number;
    expect(elapsed).toBeGreaterThanOrEqual(59_900); expect(elapsed).toBeLessThan(60_000);
  });

  it("uses the durable offline path in the sandbox simulation and syncs on reconnect", async () => {
    setSimulatedOffline(true);
    const saves = queue(); saves.enqueue("item", { response: { text: "Offline" }, flagged: true }, 800);
    await saves.flush(); expect(entries).toHaveLength(1); expect(mocks.api).not.toHaveBeenCalled();
    const finalize = vi.fn(); await expect(saves.finalize(finalize)).rejects.toThrow("offline");
    expect(finalize).not.toHaveBeenCalled(); expect(entries).toHaveLength(1);
    setSimulatedOffline(false); await saves.finalize(finalize);
    expect(entries).toHaveLength(0); expect(finalize).toHaveBeenCalledOnce();
  });

  it("splits large written journals below the proxy body limit", async () => {
    entries = Array.from({ length: 60 }, (_, index) => ({ seq: index + 1, itemId: "item", response: { text: "x".repeat(20_000) }, flagged: false, lease, elapsedMs: index, writtenAt: lease.issuedAt + index, hash: "hash" }));
    await syncJournal("attempt");
    const batches = mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/journal"));
    expect(batches).toHaveLength(2);
    for (const [, options] of batches) expect(new TextEncoder().encode(JSON.stringify(options.body)).length).toBeLessThan(750_032);
    expect(entries).toHaveLength(0);
  });

  it("can accept edits again after the server grants an audited reopening", async () => {
    const saves = queue(); await saves.finalize(vi.fn());
    expect(() => saves.enqueue("item", { response: { text: "Blocked" }, flagged: false })).toThrow("stopped");
    saves.resume(); saves.enqueue("item", { response: { text: "Recovery answer" }, flagged: false }, 800);
    await saves.finalize(vi.fn()); expect(entries).toHaveLength(0);
    expect(mocks.append).toHaveBeenCalledOnce();
  });
});
