"use client";

import { useEffect, useRef, useState } from "react";

export type PollState<T> = {
  data: T | null;
  error: unknown;
  /** Client time (ms) of the last successful load. */
  updatedAt: number | null;
  refresh: () => void;
};

/**
 * Loads now, then every `intervalMs` while the tab is visible. The timer stops when the tab is hidden and
 * refreshes once when it comes back. A load that is still running is not started again.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  const inFlight = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  });

  const run = useRef(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await loadRef.current();
      setData(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
    }
  });

  useEffect(() => {
    const tick = run.current;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => void tick(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void tick();
        start();
      } else {
        stop();
      }
    };

    void tick();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return { data, error, updatedAt, refresh: () => void run.current() };
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
