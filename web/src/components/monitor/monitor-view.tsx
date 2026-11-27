"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamMonitor, MonitorRow, ReviewPriority } from "@/lib/exam/types";
import { ToastProvider as LiveToasts, useToast as useLiveToast } from "@/components/effects/toast-stack";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Meter } from "@/components/ui/meter";
import { SectionIntro } from "@/components/exams/section-intro";
import { Stat, StatGrid } from "@/components/ui/stat";
import { formatAge, formatClock, messageOf } from "@/components/analytics/format";
import { cn } from "@/lib/utils";
import { AnnouncementsPanel } from "./announcements-panel";
import { IncidentPanel, INDICATOR_NOTICE } from "./incident-panel";
import { LeakTracer } from "./leak-tracer";
import { PriorityChip } from "./priority-chip";
import { useNow, usePoll } from "./use-poll";

const POLL_MS = 5000;
const PRIORITY_RANK: Record<ReviewPriority, number> = { high: 3, medium: 2, low: 1, none: 0 };
const GRID = "grid items-center gap-x-4 px-3 md:grid-cols-[minmax(0,2fr)_7.5rem_minmax(0,1.5fr)_4.5rem_6rem_9rem_5.5rem_8.5rem]";

type SortKey = "priority" | "name" | "deadline" | "progress";

const selectClass =
  "h-12 min-w-44 border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";

/**
 * The control room for one live exam. Counters sit on top, the board of candidates is in the middle, and an
 * announcement and leak-trace rail sits beside it. New incidents raise a toast between polls.
 */
export function MonitorView({ examId }: { examId: string }) {
  return (
    <LiveToasts>
      <ControlRoom examId={examId} />
    </LiveToasts>
  );
}

function ControlRoom({ examId }: { examId: string }) {
  const load = useCallback(() => api<ExamMonitor>(`/exams/${examId}/monitor`), [examId]);
  const poll = usePoll(load, POLL_MS);
  const now = useNow(1000);
  const live = useLiveToast();
  const [sort, setSort] = useState<SortKey>("priority");
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [highOnly, setHighOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const sortId = useId();
  const offlineId = useId();
  const highId = useId();
  const seen = useRef<Map<string, number> | null>(null);
  const reduced = useReducedMotion();

  const data = poll.data;
  // Deadlines use the server clock: the offset from the last response, never the candidate's clock.
  const offset = data && poll.updatedAt !== null ? Date.parse(data.serverNow) - poll.updatedAt : 0;
  const serverNow = now + offset;

  // Toast each new incident that arrived since the last poll. The first load only records the baseline.
  useEffect(() => {
    if (!data) return;
    const previous = seen.current;
    const next = new Map<string, number>();
    for (const row of data.rows) {
      next.set(row.attemptId, row.incidents);
      const before = previous?.get(row.attemptId);
      if (previous && before !== undefined && row.incidents > before) {
        const added = row.incidents - before;
        live.show({
          title: `${row.displayName}: ${added} new ${added === 1 ? "incident" : "incidents"}`,
          body: "Open the candidate to see the timeline. Indicators are for review.",
          tone: "info",
          duration: 6000,
        });
      }
    }
    seen.current = next;
    // `live.show` is stable for the life of the provider.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, [data]);

  const rows = useMemo(() => {
    const filtered = (data?.rows ?? []).filter(
      (row) => (!offlineOnly || !row.online) && (!highOnly || row.reviewPriority === "high"),
    );
    return [...filtered].sort((a, b) => compareRows(a, b, sort));
  }, [data, offlineOnly, highOnly, sort]);

  const openRow = data?.rows.find((row) => row.attemptId === openId);
  const liveCount = data?.inProgress ?? 0;

  return (
    <div className="grid gap-10 px-4 py-6 md:px-8 md:py-8">
      <SectionIntro
        eyebrow="Monitor / live"
        title="Control room"
        summary="Every candidate in this exam, updated every five seconds while this tab is open."
        actions={
          <div className="flex flex-wrap items-center gap-4">
            <p className="flex items-center gap-2 font-mono text-[11px] text-ink-muted" aria-live="off">
              <Badge tone="live" dot="live" size="sm">
                Live
              </Badge>
              {poll.updatedAt !== null ? `Updated ${formatAge(now - poll.updatedAt)} ago` : "Not updated yet"}
            </p>
            <Button variant="secondary" size="sm" onClick={poll.refresh}>
              Refresh
            </Button>
          </div>
        }
      >
        <p className="font-mono text-[11px] text-ink-soft">{INDICATOR_NOTICE}</p>
      </SectionIntro>

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
        <StatGrid columns={4} className="border-b border-rule pb-2">
          <Stat label="Enrolled" value={data.enrolled} />
          <Stat label="Not started" value={data.notStarted} tone="caution" />
          <Stat label="In progress" value={liveCount} focal note="Running now" />
          <Stat label="Submitted" value={data.submitted} />
        </StatGrid>
      )}

      {data && (
        <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-labelledby={`${sortId}-board`} className="grid min-w-0 content-start gap-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <h2 id={`${sortId}-board`} className="mr-auto font-mono text-[11px] tracking-[0.14em] uppercase">
                <span className="text-cobalt-deep tabular-nums">02</span>
                <span aria-hidden="true" className="text-ink-muted"> / </span>
                Board
              </h2>
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

            {data.rows.length === 0 ? (
              <EmptyState art="empty-exams" eyebrow="No attempts / 00" title="No candidate has started this exam yet." />
            ) : rows.length === 0 ? (
              <EmptyState eyebrow="No matches / 00" title="No attempts match these filters." variant="inline" />
            ) : (
              <div className="overflow-x-auto border border-ink">
                <div role="table" aria-label="Attempts for this exam" className="min-w-[860px] md:min-w-0">
                  <div
                    role="row"
                    className={cn(GRID, "h-11 border-b border-ink bg-paper-sunk font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase")}
                  >
                    <span role="columnheader">Candidate</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Answered</span>
                    <span role="columnheader" className="text-right">Flag</span>
                    <span role="columnheader" className="text-right">Time left</span>
                    <span role="columnheader">Connection</span>
                    <span role="columnheader" className="text-right">Incidents</span>
                    <span role="columnheader">Review</span>
                  </div>
                  {rows.map((row) => (
                    <BoardRow
                      key={row.attemptId}
                      row={row}
                      serverNow={serverNow}
                      reduced={reduced ?? false}
                      onOpen={() => setOpenId(row.attemptId)}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside aria-label="Announcements and leak tracing" className="grid content-start gap-8 xl:border-l xl:border-rule xl:pl-8">
            <AnnouncementsPanel examId={examId} announcements={data.announcements} onPosted={poll.refresh} />
            <div className="grid gap-3 border border-ink p-4">
              <LeakTracer examId={examId} onOpenAttempt={setOpenId} />
            </div>
          </aside>
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

function BoardRow({
  row,
  serverNow,
  reduced,
  onOpen,
}: {
  row: MonitorRow;
  serverNow: number;
  reduced: boolean;
  onOpen: () => void;
}) {
  const remaining = Date.parse(row.deadlineAt) - serverNow;
  const lastSeen = row.lastHeartbeatAt ? serverNow - Date.parse(row.lastHeartbeatAt) : null;
  const running = row.status === "in_progress";
  return (
    <motion.div
      role="row"
      layout={reduced ? false : "position"}
      transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.8 }}
      className={cn(GRID, "min-h-16 border-b border-rule bg-paper py-2 transition-colors duration-(--duration-fast) hover:bg-paper-raised")}
    >
      <span role="cell" className="grid min-w-0">
        <button type="button" onClick={onOpen} className="cursor-pointer truncate text-left font-medium underline-offset-4 hover:underline">
          {row.displayName}
        </button>
        <span className="truncate font-mono text-[11px] text-ink-muted">{row.email}</span>
      </span>
      <span role="cell">
        {running ? (
          <Badge tone="info" dot="live" size="sm">In progress</Badge>
        ) : row.status === "submitted" ? (
          <Badge tone="outline" size="sm">Submitted</Badge>
        ) : (
          <Badge tone="muted" size="sm">Closed</Badge>
        )}
      </span>
      <span role="cell" className="grid min-w-0 gap-1.5">
        <Meter
          value={row.answered}
          max={Math.max(1, row.total)}
          tone={running ? "info" : "muted"}
          label={`${row.displayName}: answered ${row.answered} of ${row.total}`}
          valueText={`${row.answered} of ${row.total} answered`}
        />
        <span className="font-mono text-[11px] text-ink-soft tabular-nums">
          {row.answered}/{row.total}
        </span>
      </span>
      <span role="cell" className="text-right font-mono tabular-nums">
        {row.flagged}
      </span>
      <span role="cell" className="text-right font-mono text-sm tabular-nums">
        {running ? formatClock(remaining) : row.status === "submitted" ? "Done" : "Closed"}
      </span>
      <span role="cell" className="grid gap-0.5">
        <span className="inline-flex items-center gap-2 text-sm">
          <span className="relative inline-flex size-2 shrink-0" aria-hidden="true">
            {row.online ? <span className="absolute inset-0 animate-breathe bg-cobalt" /> : null}
            <span className={cn("relative size-2 border", row.online ? "border-cobalt bg-cobalt" : "border-ink-muted")} />
          </span>
          <span className={row.online ? "text-cobalt-deep" : "text-ink-muted"}>{row.online ? "Online" : "Offline"}</span>
        </span>
        <span className="font-mono text-[11px] text-ink-muted">
          {lastSeen === null ? "No heartbeat yet" : `Seen ${formatAge(lastSeen)} ago`}
        </span>
      </span>
      <span role="cell" className="text-right font-mono tabular-nums">
        {row.incidents > 0 ? (
          <span className="inline-flex items-center justify-end gap-1.5 text-ink">
            <span aria-hidden="true" className="size-2 bg-amber" />
            {row.incidents}
          </span>
        ) : (
          <span className="text-ink-muted">0</span>
        )}
      </span>
      <span role="cell">
        <PriorityChip priority={row.reviewPriority} />
      </span>
    </motion.div>
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
