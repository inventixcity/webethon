"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamMonitor, MonitorSnapshotEvent } from "@/lib/exam/types";

/** Polling interval used when the live stream is unavailable. */
export const POLL_MS = 5000;
/** First reconnect delay after a dropped stream. Each further failure doubles it. */
const RETRY_BASE_MS = 1000;
/** Consecutive stream failures before the room gives up on the stream and polls. */
const MAX_STREAM_FAILURES = 2;

/**
 * connecting: no data yet. live: the stream delivered a snapshot. reconnecting: the stream dropped and is retrying.
 * polling: the stream is unavailable (missing, or it failed twice), so the room asks every few seconds.
 */
export type LiveMode = "connecting" | "live" | "reconnecting" | "polling";

export type LiveMonitor = {
  data: ExamMonitor | null;
  error: unknown;
  /** Client time (ms) of the last snapshot or load. */
  updatedAt: number | null;
  mode: LiveMode;
  refresh: () => void;
};

function isSnapshot(value: unknown): value is MonitorSnapshotEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MonitorSnapshotEvent>;
  return typeof candidate.serverNow === "string" && Array.isArray(candidate.rows);
}

/**
 * The live room's data. Opens the exam's server-sent event stream and applies each `snapshot`. If the stream is
 * missing (404) or fails twice in a row, it switches to polling every 5 seconds. While the tab is hidden, the stream
 * is closed and reopened when the tab comes back.
 */
export function useLiveMonitor(examId: string): LiveMonitor {
  const [data, setData] = useState<ExamMonitor | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [mode, setMode] = useState<LiveMode>("connecting");
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    let polling = false;

    const accept = (next: ExamMonitor) => {
      setData(next);
      setError(null);
      setUpdatedAt(Date.now());
    };

    const loadOnce = () => {
      api<ExamMonitor>(`/exams/${examId}/monitor`)
        .then((next) => {
          if (!stopped) accept(next);
        })
        .catch((cause: unknown) => {
          if (!stopped) setError(cause);
        });
    };

    const closeStream = () => {
      clearTimeout(retryTimer);
      source?.close();
      source = null;
    };

    const stopPolling = () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const startPolling = () => {
      polling = true;
      closeStream();
      setMode("polling");
      if (document.visibilityState === "visible") {
        loadOnce();
        pollTimer = setInterval(loadOnce, POLL_MS);
      }
    };

    const openStream = () => {
      if (stopped || polling || source !== null) return;
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      const next = new EventSource(`/api/v1/exams/${examId}/monitor/stream`, { withCredentials: true });
      source = next;
      next.addEventListener("snapshot", (event) => {
        if (stopped) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        if (!isSnapshot(parsed)) return;
        failures = 0;
        accept(parsed);
        setMode("live");
      });
      next.onerror = () => {
        if (stopped || source !== next) return;
        // EventSource closes for good on a non-200 answer (for example 404). Retrying would never help.
        const hardFailure = next.readyState === EventSource.CLOSED;
        closeStream();
        failures += 1;
        if (hardFailure || failures >= MAX_STREAM_FAILURES) {
          startPolling();
          return;
        }
        setMode("reconnecting");
        retryTimer = setTimeout(openStream, RETRY_BASE_MS * 2 ** (failures - 1));
      };
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (polling) startPolling();
        else openStream();
      } else {
        closeStream();
        stopPolling();
      }
    };

    refreshRef.current = loadOnce;
    loadOnce();
    if (document.visibilityState === "visible") openStream();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      closeStream();
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [examId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, error, updatedAt, mode, refresh };
}

/** The current client time, updated every `intervalMs`. Read it only in rendering, never on the server. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
