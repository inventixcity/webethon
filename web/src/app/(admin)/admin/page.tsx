"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart, StatTile } from "@/components/charts";
import { ErrorPage } from "@/components/errors/error-page";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/features/admin/client";
import type { AdminStatsOverview } from "@/lib/exam/types";

type Overview = {
  users: number;
  activeSessions: number;
  signupsPerDay: { day: string; count: number }[];
  auditEvents: number;
  httpErrorRate: number;
  http429Rate: number;
  stats: AdminStatsOverview;
};

export default function Page() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([adminApi<Omit<Overview, "stats">>("/admin/overview"), adminApi<AdminStatsOverview>("/admin-stats/overview")]).then(([value, charts]) => {
      if (live) { setData({ ...value, stats: charts }); setError(null); }
    }).catch((cause: unknown) => { if (live) setError(cause); }).finally(() => { if (live) setLoading(false); });
    setLoading(true);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [retry]);
  return <>
    <PageHeader eyebrow="Administration" title="Overview" description="A view of activity across the platform." className="mb-8" />
    {loading && !data ? <p role="status" className="py-8 font-mono text-xs text-ink-muted">LOADING PLATFORM METRICS</p> : null}
    {error && !data ? <ErrorPage code={503} as="div" onRetry={refresh} /> : null}
    {data ? <div className="grid gap-8">
      <dl className="grid grid-cols-2 gap-5 border-y border-rule py-4 md:grid-cols-4">
        <StatTile label="Accounts" value={data.users} />
        <StatTile label="Active sessions" value={data.stats.activeSessions} />
        <StatTile label="Audit events" value={data.auditEvents} />
        <StatTile label="HTTP errors · 60m" value={`${(data.httpErrorRate * 100).toFixed(2)}%`} />
      </dl>
      <section className="grid gap-6 border border-rule bg-paper-raised p-5 md:grid-cols-2">
        <BarChart label="Sign-ins per hour · last 24 hours" data={data.stats.signInsPerHour.map((row) => ({ key: new Date(row.at).toLocaleTimeString([], { hour: "2-digit" }), value: row.count, tone: "info" }))} />
        <BarChart label="Accounts by role" data={data.stats.accountsByRole.map((row) => ({ key: row.role, value: row.count }))} />
        <BarChart label="Exams by phase" data={data.stats.examsByPhase.map((row) => ({ key: row.phase, value: row.count, tone: row.phase === "ongoing" ? "info" as const : undefined }))} />
      </section>
      <section className="grid gap-3 border-t border-rule pt-5" aria-labelledby="admin-error-rates"><h2 id="admin-error-rates" className="font-mono text-[11px] tracking-[0.12em] uppercase">Service indicators</h2><p className="text-sm text-ink-soft">HTTP errors: {(data.httpErrorRate * 100).toFixed(2)}% · rate limited: {(data.http429Rate * 100).toFixed(2)}%</p></section>
      <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">Metrics refresh every 30 seconds while this page is visible.</p>
      {error ? <Button variant="secondary" size="sm" onClick={refresh}>Retry refresh</Button> : null}
    </div> : null}
  </>;
}
