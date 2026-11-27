"use client";

import { useEffect, useState } from "react";
import { BarChart, StatTile } from "@/components/charts";
import { ErrorPage } from "@/components/errors/error-page";
import { PageHeader } from "@/components/ui/page-header";
import { adminApi } from "@/features/admin/client";
import type { AdminStatsOverview } from "@/lib/exam/types";

type SystemData = { database: string; appliedMigrations: number; config: Record<string, boolean>; rateLimits: { activeKeys: number; totalHits: number } };
export default function Page() {
  const [data, setData] = useState<SystemData | null>(null);
  const [overview, setOverview] = useState<AdminStatsOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([adminApi<SystemData>("/admin/system"), adminApi<AdminStatsOverview>("/admin-stats/overview")]).then(([system, stats]) => {
      if (live) { setData(system); setOverview(stats); setError(null); }
    }).catch((cause: unknown) => { if (live) setError(cause); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [retry]);
  return <>
    <PageHeader eyebrow="Administration" title="System" description="Service health and configuration." className="mb-8" />
    {error && !data ? <ErrorPage code={503} as="div" onRetry={() => setRetry((value) => value + 1)} /> : null}
    {!data && !error ? <p role="status" className="py-8 font-mono text-xs text-ink-muted">LOADING SYSTEM HEALTH</p> : null}
    {data ? <div className="grid gap-8">
      <dl className="grid grid-cols-2 gap-5 border-y border-rule py-4 md:grid-cols-4">
        <StatTile label="Database" value={data.database} />
        <StatTile label="Migrations" value={data.appliedMigrations} />
        <StatTile label="Active sessions" value={overview?.activeSessions ?? "—"} />
        <StatTile label="Rate limit keys · 1h" value={data.rateLimits.activeKeys} />
      </dl>
      <section className="grid gap-6 border border-rule bg-paper-raised p-5 md:grid-cols-2">
        <BarChart label="Sign-ins per hour · last 24 hours" data={(overview?.signInsPerHour ?? []).map((row) => ({ key: new Date(row.at).toLocaleTimeString([], { hour: "2-digit" }), value: row.count, tone: "info" }))} />
        <BarChart label="Rate limit activity · last hour" data={[
          { key: "Active keys", value: data.rateLimits.activeKeys, tone: "info" },
          { key: "Hits", value: data.rateLimits.totalHits, tone: "caution" },
        ]} />
        <BarChart label="Accounts by role" data={(overview?.accountsByRole ?? []).map((row) => ({ key: row.role, value: row.count }))} />
        <BarChart label="Exams by phase" data={(overview?.examsByPhase ?? []).map((row) => ({ key: row.phase, value: row.count }))} />
      </section>
      <section className="grid gap-3 border-t border-rule pt-5">
        <h2 className="font-mono text-[11px] tracking-[0.12em] uppercase">Service configuration</h2>
        <dl className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2">
          {Object.entries(data.config).map(([key, value]) => <div key={key} className="flex justify-between gap-3 bg-paper p-4"><dt className="font-mono text-[11px] text-ink-muted">{key.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}</dt><dd className="text-sm tabular-nums">{value ? "Enabled" : "Disabled"}</dd></div>)}
        </dl>
      </section>
      <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">Metrics refresh every 30 seconds while this page is visible.</p>
    </div> : null}
  </>;
}
