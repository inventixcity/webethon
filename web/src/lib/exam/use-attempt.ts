"use client";

/** useAttempt(attemptId) returns {status, error, payload, answers, setAnswer, toggleFlag,
 * saveState, pendingCount, remainingMs, deadlineAt, closed, deviceActive, takeover,
 * submit(): Promise<void>, announcements, network}. submit rejects on any save/sync/finalize
 * failure. Every edit is durable before network I/O; submit and expiry share the same barrier.
 * Server time uses performance.now. Offline reload uses the persisted lease receipt wall delta;
 * this fallback cannot prove a local clock was unchanged, so the server independently enforces
 * lease, receipt, deadline and grace bounds. A late local edit is never clamped back into time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api/client";
import type { AnswerResponse, Announcement, AttemptPayload } from "@/lib/exam/types";
import { observeServerTime, serverNowMs } from "@/lib/exam/clock";
import { attemptHeaders } from "@/lib/exam/device";
import { cacheAttempt, getMeta, initializeJournal, leaseElapsed, listEntries, pendingCount, setLease } from "@/lib/exam/journal";
import { AttemptSaveQueue, heartbeat, syncJournal, type SavedValue } from "@/lib/exam/sync";
import { isNetworkOnline, useHeartbeatQuality } from "@/lib/exam/network";

type AnswerState = "saved" | "saving" | "queued" | "offline" | "error";
export type AttemptAnswer = { response: AnswerResponse; flagged: boolean; state: AnswerState };

export function restoreAnswers(payload: AttemptPayload, entries: Awaited<ReturnType<typeof listEntries>>): Record<string, AttemptAnswer> {
  const answers: Record<string, AttemptAnswer> = {};
  payload.answers.forEach((answer) => { answers[answer.itemId] = { response: answer.response, flagged: answer.flagged, state: "saved" }; });
  for (const entry of entries) if (entry.seq > payload.journal.seq) answers[entry.itemId] = { response: entry.response, flagged: entry.flagged, state: "queued" };
  return answers;
}

export function useAttempt(attemptId: string) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<AttemptPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, AttemptAnswer>>({});
  const [pending, setPending] = useState(0);
  const [remainingMs, setRemainingMs] = useState(0);
  const [closed, setClosed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deviceActive, setDeviceActive] = useState(true);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const values = useRef<Record<string, AttemptAnswer>>({});
  const payloadRef = useRef<AttemptPayload | null>(null);
  const queue = useRef<AttemptSaveQueue | null>(null);
  const submission = useRef<Promise<void> | null>(null);
  const submitted = useRef(false);
  const recovering = useRef(false);
  const lastAnnouncement = useRef<string | null>(null);
  const mounted = useRef(false);
  const { status: network, record } = useHeartbeatQuality();
  const deadlineAt = payload?.deadlineAt ?? null;
  const refreshPending = useCallback(async () => {
    const entries = await listEntries(attemptId, Number.MAX_SAFE_INTEGER);
    if (!mounted.current) return;
    setPending(entries.length);
    const pendingItems = new Set(entries.map((entry) => entry.itemId));
    let changed = false;
    const next = { ...values.current };
    for (const [id, answer] of Object.entries(next)) {
      if ((answer.state === "queued" || answer.state === "offline") && !pendingItems.has(id)) { next[id] = { ...answer, state: "saved" }; changed = true; }
    }
    if (changed) { values.current = next; setAnswers(next); }
  }, [attemptId]);
  const updateAnswer = useCallback((id: string, answer: AttemptAnswer) => {
    values.current = { ...values.current, [id]: answer };
    if (mounted.current) setAnswers(values.current);
  }, []);

  const submit = useCallback((): Promise<void> => {
    if (submission.current) return submission.current;
    if (submitted.current) return Promise.resolve();
    if (!queue.current) return Promise.reject(new Error("The attempt is still loading."));
    setSubmitting(true); setError(null);
    const promise = queue.current.finalize(() => api(`/attempts/${encodeURIComponent(attemptId)}/submit`, { body: { confirm: true }, headers: attemptHeaders() }))
      .then(() => { submitted.current = true; if (mounted.current) setClosed(true); })
      .catch((cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not submit the attempt."); throw cause; })
      .finally(() => { submission.current = null; if (mounted.current) setSubmitting(false); void refreshPending(); });
    submission.current = promise;
    return promise;
  }, [attemptId, refreshPending]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setStatus("loading"); submitted.current = false;
    void (async () => {
      try {
        let result: AttemptPayload;
        try {
          result = await api<AttemptPayload>(`/attempts/${encodeURIComponent(attemptId)}`, { headers: attemptHeaders() });
          observeServerTime(result.serverNow);
          await initializeJournal(attemptId, result.journal.genesis, result.journal.head, result.journal.seq, Math.max(0, ...result.answers.map((answer) => answer.clientSeq)));
          await setLease(attemptId, result.lease);
          await cacheAttempt(attemptId, result);
        } catch (cause) {
          // Only transport failure permits offline cache recovery; authorization errors never do.
          if (!(cause instanceof ApiError) || cause.status !== 0) throw cause;
          const meta = await getMeta(attemptId);
          if (!meta.payload || !meta.lease) throw cause;
          result = meta.payload;
          observeServerTime(new Date(meta.lease.issuedAt + await leaseElapsed(meta)).toISOString());
          recovering.current = true;
        }
        const restored = restoreAnswers(result, await listEntries(attemptId, Number.MAX_SAFE_INTEGER));
        if (!active) return;
        payloadRef.current = result; values.current = restored;
        queue.current = new AttemptSaveQueue(attemptId, {
          journalEnabled: result.journal.enabled, lease: () => payloadRef.current?.lease ?? null,
          offline: () => recovering.current,
          onState: (itemId, state) => { if (!active) return; const value = values.current[itemId]; if (value) updateAnswer(itemId, { ...value, state }); void refreshPending(); },
          onDeviceActive: (value) => { if (active) setDeviceActive(value); },
          onClosed: () => { /* A rejected late PUT can still be recovered through journal grace. */ },
        });
        setPayload(result); setAnswers(restored); setDeviceActive(result.deviceActive);
        setClosed(result.status !== "in_progress"); setAnnouncements(result.announcements);
        lastAnnouncement.current = result.announcements.at(-1)?.createdAt ?? null;
        setRemainingMs(Math.max(0, Date.parse(result.deadlineAt) - serverNowMs()));
        setStatus("ready"); await refreshPending();
      } catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : "Unable to load attempt."); setStatus("error"); } }
    })();
    return () => { active = false; mounted.current = false; queue.current?.dispose(); queue.current = null; };
  }, [attemptId, refreshPending, updateAnswer]);

  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    let failures = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const run = async () => {
      const started = performance.now();
      try {
        const data = await heartbeat(attemptId, await pendingCount(attemptId), lastAnnouncement.current);
        if (cancelled) return;
        record(performance.now() - started); failures = 0; recovering.current = false;
        setDeviceActive(data.deviceActive);
        const current = payloadRef.current;
        if (current) { const next = { ...current, deadlineAt: data.deadlineAt, status: data.status, lease: data.lease }; payloadRef.current = next; setPayload(next); await cacheAttempt(attemptId, next); }
        if (data.status === "in_progress" && Date.parse(data.deadlineAt) > serverNowMs()) { submitted.current = false; setClosed(false); }
        if (data.announcements.length) {
          lastAnnouncement.current = data.announcements.at(-1)?.createdAt ?? lastAnnouncement.current;
          setAnnouncements((old) => [...new Map([...old, ...data.announcements].map((item) => [item.id, item])).values()]);
        }
        if (data.deviceActive && isNetworkOnline()) {
          await queue.current?.flush();
          await syncJournal(attemptId, { onDeviceActive: setDeviceActive });
          if (submission.current === null && Date.parse(data.deadlineAt) <= serverNowMs() && !submitted.current) await submit();
        }
        if (data.status !== "in_progress" && await pendingCount(attemptId) === 0) setClosed(true);
        await refreshPending();
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 409 && (cause.details as { reason?: string })?.reason === "device") setDeviceActive(false);
        failures += 1; recovering.current = failures >= 2; record(null);
      }
      if (!cancelled) timeout = setTimeout(run, failures || !isNetworkOnline() ? 5000 : 15000);
    };
    timeout = setTimeout(run, 0);
    const reconnect = () => { clearTimeout(timeout); if (!cancelled) timeout = setTimeout(run, 0); };
    window.addEventListener("online", reconnect);
    return () => { cancelled = true; clearTimeout(timeout); window.removeEventListener("online", reconnect); };
  }, [status, attemptId, record, refreshPending, submit]);

  useEffect(() => {
    if (!deadlineAt || status !== "ready") return;
    let attempted = false;
    const tick = () => {
      const left = Date.parse(deadlineAt) - serverNowMs();
      setRemainingMs(Math.max(0, left));
      if (left <= 0 && !attempted && !submitted.current) { attempted = true; void submit().catch(() => {}); }
    };
    tick(); const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [deadlineAt, status, submit]);

  const setAnswer = useCallback((itemId: string, response: AnswerResponse, typing?: SavedValue["typing"]) => {
    const current = payloadRef.current;
    if (closed || submission.current || !deviceActive || !current || Date.parse(current.deadlineAt) <= serverNowMs()) return;
    const flagged = values.current[itemId]?.flagged ?? false;
    updateAnswer(itemId, { response, flagged, state: "saving" });
    queue.current?.enqueue(itemId, { response, flagged, typing }, "text" in response ? 800 : 0);
  }, [closed, deviceActive, updateAnswer]);

  const toggleFlag = useCallback((itemId: string) => {
    const current = payloadRef.current;
    if (closed || submission.current || !deviceActive || !current || Date.parse(current.deadlineAt) <= serverNowMs()) return;
    const previous = values.current[itemId];
    const response = previous?.response ?? (current.items.find((item) => item.id === itemId)?.kind === "written" ? { text: "" } : { selected: [] });
    const flagged = !previous?.flagged;
    updateAnswer(itemId, { response, flagged, state: "saving" });
    queue.current?.enqueue(itemId, { response, flagged });
  }, [closed, deviceActive, updateAnswer]);

  const takeover = useCallback(async () => {
    await api(`/attempts/${encodeURIComponent(attemptId)}/takeover`, { body: {}, headers: attemptHeaders() });
    const data = await heartbeat(attemptId, await pendingCount(attemptId), lastAnnouncement.current);
    if (payloadRef.current) { const next = { ...payloadRef.current, lease: data.lease, deadlineAt: data.deadlineAt }; payloadRef.current = next; setPayload(next); }
    setDeviceActive(true);
  }, [attemptId]);
  const states = Object.values(answers).map((answer) => answer.state);
  const saveState: "saved" | "saving" | "offline" | "syncing" | "error" = submitting ? "syncing" : states.includes("error") || error ? "error" : states.includes("saving") ? "saving" : pending || states.includes("queued") || states.includes("offline") ? "offline" : "saved";
  return { status, error, payload, answers, setAnswer, toggleFlag, saveState, pendingCount: pending + states.filter((state) => state === "saving").length, remainingMs, deadlineAt, closed, deviceActive, takeover, submit, announcements, network };
}
