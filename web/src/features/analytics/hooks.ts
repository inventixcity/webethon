"use client";
import { useEffect, useState } from "react";
import { getStats, type Stats, type StatsOptions } from "./client";
export function useStats(entity: string, options: StatsOptions) {
  const [data, setData] = useState<Stats>(); const [loading, setLoading] = useState(true); const [error, setError] = useState<unknown>(); const [revision, setRevision] = useState(0);
  const query = JSON.stringify(options);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(undefined); setData(undefined);
    getStats(entity, JSON.parse(query) as StatsOptions, controller.signal).then(setData).catch(err => { if (!controller.signal.aborted) setError(err); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [entity, query, revision]);
  return { data, loading, error, reload: () => setRevision(n => n + 1) };
}
