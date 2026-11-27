"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { Exam } from "@/lib/exam/types";
import { EXAM_CHANGED_EVENT } from "./format";

export type Resource<T> = {
  data: T | null;
  error: unknown;
  /** True until the first answer for the current path and refresh key arrives. */
  loading: boolean;
  reload: () => void;
};

/**
 * Fetches `path` through the same-origin API proxy. Answers for an older path or key are dropped, so a fast
 * click cannot paint stale data. `refreshKey` is any JSON-able value that forces a refetch when it changes.
 */
export function useResource<T>(path: `/${string}` | null, refreshKey: unknown = null): Resource<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; data: T | null; error: unknown } | null>(null);
  const key = JSON.stringify([path, tick, refreshKey ?? null]);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    api<T>(path)
      .then((data) => {
        if (live) setResult({ key, data, error: null });
      })
      .catch((error: unknown) => {
        if (live) setResult({ key, data: null, error });
      });
    return () => {
      live = false;
    };
  }, [key, path]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  const current = result !== null && result.key === key ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: path !== null && current === null,
    reload,
  };
}

/** One exam, refetched whenever any part of the examiner UI reports a change to it. */
export function useExam(examId: string): Resource<Exam> {
  const resource = useResource<Exam>(`/exams/${encodeURIComponent(examId)}`);
  const { reload } = resource;

  useEffect(() => {
    function onChanged(event: Event) {
      if ((event as CustomEvent<string>).detail === examId) reload();
    }
    window.addEventListener(EXAM_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(EXAM_CHANGED_EVENT, onChanged);
  }, [examId, reload]);

  return resource;
}
