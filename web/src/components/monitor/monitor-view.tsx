"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ExamMonitor, MonitorRow, ReviewPriority } from "@/lib/exam/types";
import { ToastProvider as LiveToasts, useToast as useLiveToast } from "@/components/effects/toast-stack";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Meter } from "@/components/ui/meter";
import { SectionIntro } from "@/components/exams/section-intro";
import { formatAge, formatClock, messageOf } from "@/components/analytics/format";
import { cn } from "@/lib/utils";
import { AnnouncementsPanel } from "./announcements-panel";
import { IncidentPanel, INDICATOR_NOTICE } from "./incident-panel";
import { LeakTracer } from "./leak-tracer";
import { OutageCreditDialog } from "./outage-credit-dialog";
import { PriorityChip } from "./priority-chip";
import { ActivityCharts } from "./activity-charts";
import { LiveMode, POLL_MS, useLiveMonitor, useNow } from "./use-live-monitor";

/** How long a changed row stays highlighted. */
const FLASH_MS = 1600;
/** The screen reader summary is updated at most this often. */
const ANNOUNCE_MS = 15000;
const PRIORITY_RANK: Record<ReviewPriority, number> = { high: 3, medium: 2, low: 1, none: 0 };
const GRID = "grid items-center gap-x-4 px-3 max-md:grid-cols-1 max-md:gap-x-4 max-md:gap-y-3 max-md:px-4 md:grid-cols-[minmax(0,2fr)_7.5rem_minmax(0,1.5fr)_4.5rem_6rem_9rem_5.5rem_8.5rem]";

type SortKey = "priority" | "name" | "deadline" | "progress";

const selectClass =
  "h-10 min-w-44 border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

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
  const poll = useLiveMonitor(examId);
  const now = useNow(1000);
  const live = useLiveToast();
  const [sort, setSort] = useState<SortKey>("priority");
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [highOnly, setHighOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creditOpen, setCreditOpen] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const [announced, setAnnounced] = useState("");
  const sortId = useId();
  const seen = useRef<Map<string, { incidents: number; signature: string }> | null>(null);
  const reduced = useReducedMotion();

  const data = poll.data;
  // Deadlines use the server clock: the offset from the last snapshot, never the candidate's clock.
  const offset = data && poll.updatedAt !== null ? Date.parse(data.serverNow) - poll.updatedAt : 0;
  const serverNow = now + offset;

  // Toast each new incident, and flash each row whose visible state changed, since the last snapshot. The first
  // snapshot only records the baseline.
  useEffect(() => {
    if (!data) return;
    const previous = seen.current;
    const next = new Map<string, { incidents: number; signature: string }>();
    const changed: string[] = [];
    for (const row of data.rows) {
      const signature = rowSignature(row);
      next.set(row.attemptId, { incidents: row.incidents, signature });
      const before = previous?.get(row.attemptId);
      if (before === undefined) continue;
      if (before.signature !== signature) changed.push(row.attemptId);
      if (row.incidents > before.incidents) {
        const added = row.incidents - before.incidents;
        live.show({
          title: `${row.displayName}: ${added} new ${added === 1 ? "incident" : "incidents"}`,
          body: "Open the candidate to see the timeline. Indicators are for review.",
          tone: "info",
          duration: 6000,
        });
      }
    }
    seen.current = next;
    if (changed.length > 0) {
      setFlashes((current) => {
        const updated = { ...current };
        for (const id of changed) updated[id] = (updated[id] ?? 0) + 1;
        return updated;
      });
    }
    // `live.show` is stable for the life of the provider.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, [data]);

  // One summary for screen readers, at most every 15 seconds. Row-by-row changes are not announced.
  const summary = data ? summaryText(data) : "";
  const summaryRef = useRef(summary);
  useEffect(() => {
    summaryRef.current = summary;
    if (announced === "" && summary !== "") setAnnounced(summary);
  }, [summary, announced]);
  useEffect(() => {
    const id = setInterval(() => setAnnounced(summaryRef.current), ANNOUNCE_MS);
    return () => clearInterval(id);
  }, []);

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
        summary="Every candidate in this exam, updated from the server while this tab is open."
        actions={
          <div className="flex flex-wrap items-center gap-3 border-y border-rule bg-paper-raised px-3 py-2">
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-ink-muted" aria-live="off">
              <LiveIndicator mode={poll.mode} />
              <span>{poll.updatedAt !== null ? `Updated ${formatAge(now - poll.updatedAt)} ago` : "Not updated yet"}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={poll.refresh}>
              Refresh
            </Button>
            <Button variant="secondary" size="sm" disabled={!data} onClick={() => setCreditOpen(true)}>
              Credit an outage
            </Button>
          </div>
        }
      >
        <p className="font-mono text-[11px] text-ink-soft">{INDICATOR_NOTICE}</p>
      </SectionIntro>
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>

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
        <dl className="grid grid-cols-2 border-y border-rule md:grid-cols-4">
          <Kpi label="Enrolled" value={data.enrolled} detail="Candidates" tone="neutral" />
          <Kpi label="Not started" value={data.notStarted} detail={`${percent(data.notStarted, data.enrolled)}% enrolled`} tone="amber" />
          <Kpi label="In progress" value={liveCount} detail={`${percent(liveCount, data.enrolled)}% enrolled · live`} tone="cobalt" />
          <Kpi label="Submitted" value={data.submitted} detail={`${percent(data.submitted, data.enrolled)}% enrolled`} tone="ink" />
        </dl>
      )}

      {data && <ActivityCharts examId={examId} snapshot={data} />}

      {data && (
        <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-labelledby={`${sortId}-board`} className="grid min-w-0 content-start gap-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <h2 id={`${sortId}-board`} className="mr-auto font-mono text-[11px] tracking-[0.14em] uppercase">
                <span className="text-cobalt-deep tabular-nums">02</span>
                <span aria-hidden="true" className="text-ink-muted"> / </span>
                Board
              </h2>
              <Button variant="secondary" size="sm" className="aria-pressed:bg-fill aria-pressed:text-on-fill max-md:min-h-10 max-md:border max-md:px-3" aria-pressed={offlineOnly} onClick={() => setOfflineOnly(!offlineOnly)}>Offline only</Button>
              <Button variant="secondary" size="sm" className="aria-pressed:bg-fill aria-pressed:text-on-fill max-md:min-h-10 max-md:border max-md:px-3" aria-pressed={highOnly} onClick={() => setHighOnly(!highOnly)}>High priority only</Button>
              <div className="grid gap-2">
                <label htmlFor={sortId} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Sort by</label>
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
              <div className="border-y border-ink md:overflow-x-auto md:border">
                <div role="table" aria-label="Attempts for this exam" className="min-w-0 md:min-w-[1000px]">
                  <div
                    role="row"
                    className="hidden h-11 border-b border-ink bg-paper-sunk font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase md:grid md:grid-cols-[minmax(0,2fr)_7.5rem_minmax(0,1.5fr)_4.5rem_6rem_9rem_5.5rem_8.5rem] md:items-center md:gap-x-4 md:px-3"
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
                      flashKey={flashes[row.attemptId] ?? 0}
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
      {creditOpen && data && (
        <OutageCreditDialog
          examId={examId}
          serverNow={serverNow}
          onCredited={poll.refresh}
          onOpenChange={setCreditOpen}
        />
      )}
    </div>
  );
}

/** The live state of the stream, as text and a mark. Colour is never the only signal. */
function LiveIndicator({ mode }: { mode: LiveMode }) {
  if (mode === "live") {
    return (
      <Badge tone="live" dot="live" size="sm">
        Live
      </Badge>
    );
  }
  if (mode === "polling") {
    return (
      <Badge tone="outline" size="sm">
        Polling every {POLL_MS / 1000} s
      </Badge>
    );
  }
  return (
    <Badge tone="dashed" size="sm">
      {mode === "reconnecting" ? "Reconnecting" : "Connecting"}
    </Badge>
  );
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function Kpi({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "neutral" | "amber" | "cobalt" | "ink" }) {
  const rule = tone === "amber" ? "border-t-amber" : tone === "cobalt" ? "border-t-cobalt" : tone === "ink" ? "border-t-ink" : "border-t-rule";
  return (
    <div className={cn("grid min-h-32 content-between gap-3 border-t-4 bg-paper-raised p-4", rule)}>
      <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
      <dd className={cn("text-4xl leading-none font-semibold tabular-nums", tone === "cobalt" && "text-cobalt-deep")}>
        {value}
      </dd>
      <dd className="font-mono text-[11px] text-ink-soft">
        {tone === "cobalt" && <span className="mr-2 inline-block size-2 animate-breathe bg-cobalt" aria-hidden="true" />}
        {detail}
      </dd>
    </div>
  );
}

/** The one-line summary for screen readers. It describes counts only, never a verdict about a candidate. */
function summaryText(data: ExamMonitor): string {
  const offline = data.rows.filter((row) => row.status === "in_progress" && !row.online).length;
  const high = data.rows.filter((row) => row.reviewPriority === "high").length;
  return `${data.inProgress} in progress, ${data.submitted} submitted, ${offline} offline, ${high} high review priority.`;
}

/** The fields a board row shows that can change between snapshots. Heartbeat time is left out: it moves every few seconds. */
function rowSignature(row: MonitorRow): string {
  return [row.status, row.answered, row.flagged, row.online, row.incidents, row.reviewPriority].join("|");
}

function BoardRow({
  row,
  serverNow,
  reduced,
  flashKey,
  onOpen,
}: {
  row: MonitorRow;
  serverNow: number;
  reduced: boolean;
  /** Changes each time the row's visible state changes, which starts a short highlight. */
  flashKey: number;
  onOpen: () => void;
}) {
  const remaining = Date.parse(row.deadlineAt) - serverNow;
  const lastSeen = row.lastHeartbeatAt ? serverNow - Date.parse(row.lastHeartbeatAt) : null;
  const running = row.status === "in_progress";
  const [flashing, setFlashing] = useState(false);
  const lastFlash = useRef(flashKey);
  useEffect(() => {
    if (lastFlash.current === flashKey) return;
    lastFlash.current = flashKey;
    setFlashing(true);
    const id = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(id);
  }, [flashKey]);
  return (
    <motion.div
      role="row"
      tabIndex={0}
      aria-label={`${row.displayName}, ${row.status.replace("_", " ")}, ${row.answered} of ${row.total} answered. Open integrity details.`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      layout={reduced ? false : "position"}
      transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.8 }}
      className={cn(
        GRID,
        "min-h-16 cursor-pointer border-b border-rule py-4 transition-colors duration-(--duration-slow) odd:bg-paper-raised hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus max-md:my-3 max-md:grid-cols-1 max-md:border max-md:bg-paper-raised max-md:py-4",
        flashing ? "bg-cobalt/10" : "bg-paper",
      )}
    >
      <span role="cell" data-label="Candidate" className="grid min-w-0 max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:items-baseline max-md:gap-2 max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        <span className="col-start-2 grid min-w-0">
          <span className="truncate text-left font-medium underline-offset-4 hover:underline">{row.displayName}</span>
          <span className="truncate font-mono text-[11px] text-ink-muted">{row.email}</span>
        </span>
      </span>
      <span role="cell" data-label="Status" className="max-md:grid max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:items-center max-md:gap-2 max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        {running ? (
          <Badge tone="info" dot="live" size="sm">In progress</Badge>
        ) : row.status === "submitted" ? (
          <Badge tone="outline" size="sm">Submitted</Badge>
        ) : (
          <Badge tone="muted" size="sm">Closed</Badge>
        )}
      </span>
      <span role="cell" data-label="Answered" className="grid min-w-0 gap-1.5 max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:items-center max-md:gap-2 max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)] [&>div]:max-md:col-start-2 [&>span]:max-md:col-start-2">
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
      <span role="cell" data-label="Flagged" className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-right font-mono tabular-nums max-md:items-baseline max-md:text-left max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]">
        {row.flagged}
      </span>
      <span role="cell" data-label="Time left" className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-right font-mono text-sm tabular-nums max-md:items-baseline max-md:text-left max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)] [&>*]:max-md:col-start-2">
        {running ? formatClock(remaining) : row.status === "submitted" ? "Done" : "Closed"}
      </span>
      <span role="cell" data-label="Connection" className="grid gap-0.5 max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:items-center max-md:gap-2 max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)] [&>*]:max-md:col-start-2">
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
      <span role="cell" data-label="Incidents" className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-right font-mono tabular-nums max-md:items-baseline max-md:text-left max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)] [&>*]:max-md:col-start-2">
        {row.incidents > 0 ? (
          <span className="inline-flex items-center justify-end gap-1.5 text-ink">
            <span aria-hidden="true" className="size-2 bg-amber" />
            {row.incidents}
          </span>
        ) : (
          <span className="text-ink-muted">0</span>
        )}
      </span>
      <span role="cell" data-label="Review priority" className="grid gap-1 max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:items-center max-md:gap-2 max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.04em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)] [&>*]:max-md:col-start-2">
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
