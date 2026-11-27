"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamMonitor, MonitorRow, ReviewPriority } from "@/lib/exam/types";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { formatAge, formatClock, messageOf } from "@/components/analytics/format";
import { cn } from "@/lib/utils";
import { AnnouncementsPanel } from "./announcements-panel";
import { IncidentPanel, INDICATOR_NOTICE } from "./incident-panel";
import { LeakTracer } from "./leak-tracer";
import { PriorityChip } from "./priority-chip";
import { useNow, usePoll } from "./use-poll";

const POLL_MS = 5000;
const PRIORITY_RANK: Record<ReviewPriority, number> = { high: 3, medium: 2, low: 1, none: 0 };
const STATUS_LABEL: Record<MonitorRow["status"], string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Expired",
};

type SortKey = "priority" | "name" | "deadline" | "progress";

const selectClass =
  "h-12 min-w-44 border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";

/** Live view of one exam's attempts. Polls every 5 s while the tab is visible. */
export function MonitorView({ examId }: { examId: string }) {
  const load = useCallback(() => api<ExamMonitor>(`/exams/${examId}/monitor`), [examId]);
  const poll = usePoll(load, POLL_MS);
  const now = useNow(1000);
  const [sort, setSort] = useState<SortKey>("priority");
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [highOnly, setHighOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sortId = useId();
  const offlineId = useId();
  const highId = useId();

  const data = poll.data;
  // Deadlines use the server clock: the offset from the last response, never the candidate's clock.
  const offset = data && poll.updatedAt !== null ? Date.parse(data.serverNow) - poll.updatedAt : 0;
  const serverNow = now + offset;

  const rows = useMemo(() => {
    const filtered = (data?.rows ?? []).filter(
      (row) => (!offlineOnly || !row.online) && (!highOnly || row.reviewPriority === "high"),
    );
    return [...filtered].sort((a, b) => compareRows(a, b, sort));
  }, [data, offlineOnly, highOnly, sort]);

  const openRow = data?.rows.find((row) => row.attemptId === openId);

  return (
    <div className="grid gap-12 px-4 py-8 md:px-8">
      <header className="grid gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Monitor</p>
            <h2 className="mt-2 text-3xl leading-none font-semibold tracking-tight md:text-4xl">Live attempts</h2>
          </div>
          <div className="flex items-center gap-4">
            <p className="font-mono text-[11px] text-ink-muted" aria-live="off">
              {poll.updatedAt !== null ? `Updated ${formatAge(now - poll.updatedAt)} ago` : "Not updated yet"}
            </p>
            <Button variant="secondary" size="sm" onClick={poll.refresh}>
              Refresh
            </Button>
          </div>
        </div>
        <p className="font-mono text-[11px] text-ink-soft">{INDICATOR_NOTICE}</p>

        {data && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            {[
              ["Enrolled", data.enrolled],
              ["Not started", data.notStarted],
              ["In progress", data.inProgress],
              ["Submitted", data.submitted],
            ].map(([label, value]) => (
              <div key={label} className="border-t border-rule pt-3">
                <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
                <dd className="mt-1 text-3xl font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>

      {poll.error !== null && !data && (
        <div className="grid gap-3 border border-vermilion-deep p-5">
          <p className="text-sm text-vermilion-deep">{messageOf(poll.error)}</p>
          <div>
            <Button variant="secondary" size="sm" onClick={poll.refresh}>
              Try again
            </Button>
          </div>
        </div>
      )}
      {poll.error !== null && data && (
        <p role="status" className="text-sm text-vermilion-deep">
          Could not refresh. Showing the last update.
        </p>
      )}

      {!data && poll.error === null && <BrailleSpinner label="Loading monitor" className="text-ink" />}

      {data && (
        <section aria-labelledby={`${sortId}-table`} className="grid gap-5">
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex items-center gap-3">
              <Checkbox id={offlineId} checked={offlineOnly} onCheckedChange={(value) => setOfflineOnly(value === true)} />
              <Label htmlFor={offlineId}>Offline only</Label>
            </div>
            <div className="flex items-center gap-3">
              <Checkbox id={highId} checked={highOnly} onCheckedChange={(value) => setHighOnly(value === true)} />
              <Label htmlFor={highId}>High priority only</Label>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={sortId}>Sort by</Label>
              <select id={sortId} className={selectClass} value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                <option value="priority">Review priority</option>
                <option value="name">Name</option>
                <option value="deadline">Time remaining</option>
                <option value="progress">Least answered</option>
              </select>
            </div>
          </div>
          <h3 id={`${sortId}-table`} className="sr-only">
            Candidate attempts
          </h3>

          {data.rows.length === 0 ? (
            <EmptyState art="offline" eyebrow="No attempts / 00" title="No candidate has started this exam yet." />
          ) : rows.length === 0 ? (
            <EmptyState eyebrow="No matches / 00" title="No attempts match these filters." variant="inline" />
          ) : (
            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[880px] text-left text-sm">
                <caption className="sr-only">Attempts for this exam. Select a candidate name to see review details.</caption>
                <thead className="bg-paper-sunk">
                  <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                    <th scope="col" className="px-3 py-3 font-medium">Candidate</th>
                    <th scope="col" className="px-3 py-3 font-medium">Status</th>
                    <th scope="col" className="px-3 py-3 font-medium">Progress</th>
                    <th scope="col" className="px-3 py-3 font-medium">Flagged</th>
                    <th scope="col" className="px-3 py-3 font-medium">Time left</th>
                    <th scope="col" className="px-3 py-3 font-medium">Connection</th>
                    <th scope="col" className="px-3 py-3 font-medium">Incidents</th>
                    <th scope="col" className="px-3 py-3 font-medium">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const ratio = row.total > 0 ? row.answered / row.total : 0;
                    const remaining = Date.parse(row.deadlineAt) - serverNow;
                    const lastSeen = row.lastHeartbeatAt ? serverNow - Date.parse(row.lastHeartbeatAt) : null;
                    return (
                      <tr key={row.attemptId} className="border-t border-rule align-top">
                        <th scope="row" className="px-3 py-3 font-normal">
                          <button
                            type="button"
                            onClick={() => setOpenId(row.attemptId)}
                            className="cursor-pointer text-left underline-offset-4 hover:underline"
                          >
                            <span className="block font-medium">{row.displayName}</span>
                            <span className="block font-mono text-[11px] break-all text-ink-muted">{row.email}</span>
                          </button>
                        </th>
                        <td className="px-3 py-3 whitespace-nowrap">{STATUS_LABEL[row.status]}</td>
                        <td className="px-3 py-3">
                          <div className="grid min-w-28 gap-1">
                            <div
                              role="progressbar"
                              aria-label={`${row.displayName}: answered ${row.answered} of ${row.total}`}
                              aria-valuemin={0}
                              aria-valuemax={row.total}
                              aria-valuenow={row.answered}
                              className="h-2 bg-paper-sunk"
                            >
                              <div className="h-full bg-ink" style={{ width: `${Math.round(ratio * 100)}%` }} />
                            </div>
                            <span className="font-mono text-[11px] text-ink-soft">
                              {row.answered}/{row.total}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums">{row.flagged}</td>
                        <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap">
                          {row.status === "submitted" ? "Submitted" : row.status === "expired" ? "Closed" : formatClock(remaining)}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-2 border",
                                row.online ? "border-cobalt bg-cobalt" : "border-ink-muted bg-transparent",
                              )}
                            />
                            <span className={row.online ? "text-cobalt-deep" : "text-ink-muted"}>
                              {row.online ? "Online" : "Offline"}
                            </span>
                          </span>
                          <span className="block font-mono text-[11px] text-ink-muted">
                            {lastSeen === null ? "No heartbeat yet" : `Last heartbeat ${formatAge(lastSeen)} ago`}
                          </span>
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums">{row.incidents}</td>
                        <td className="px-3 py-3">
                          <PriorityChip priority={row.reviewPriority} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data && (
        <div className="grid gap-12 lg:grid-cols-2">
          <AnnouncementsPanel examId={examId} announcements={data.announcements} onPosted={poll.refresh} />
          <LeakTracer examId={examId} onOpenAttempt={setOpenId} />
        </div>
      )}

      {openId !== null && (
        <IncidentPanel
          attemptId={openId}
          title={openRow?.displayName ?? "Candidate"}
          onClose={() => setOpenId(null)}
          onChanged={poll.refresh}
        />
      )}
    </div>
  );
}

function compareRows(a: MonitorRow, b: MonitorRow, sort: SortKey): number {
  const byName = a.displayName.localeCompare(b.displayName);
  switch (sort) {
    case "name":
      return byName;
    case "deadline":
      return Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt) || byName;
    case "progress": {
      const ra = a.total > 0 ? a.answered / a.total : 0;
      const rb = b.total > 0 ? b.answered / b.total : 0;
      return ra - rb || byName;
    }
    case "priority":
      return PRIORITY_RANK[b.reviewPriority] - PRIORITY_RANK[a.reviewPriority] || byName;
  }
}
