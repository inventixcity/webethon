"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamResults, GradingStatus, ResultRow } from "@/lib/exam/types";
import { describeError } from "@/lib/errors/describe";
import { useToast } from "@/components/feedback/toaster";
import { HoldButton } from "@/components/effects/hold-button";
import { ConfirmDialog } from "@/components/monitor/confirm-dialog";
import { PriorityChip } from "@/components/monitor/priority-chip";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Meter } from "@/components/ui/meter";
import { SectionIntro } from "@/components/exams/section-intro";
import { Stat, StatGrid } from "@/components/ui/stat";
import { formatDateTime, formatMarks, formatPercent, messageOf } from "@/components/analytics/format";
import { cn } from "@/lib/utils";
import { downloadCsv, resultsToCsv } from "./csv";

const STATUS: Record<ResultRow["status"], string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Expired",
};
const GRADING: Record<GradingStatus, string> = { pending: "Pending", partial: "Partial", complete: "Complete" };
const GRADING_TONE: Record<GradingStatus, "outline" | "caution" | "muted"> = {
  pending: "caution",
  partial: "caution",
  complete: "outline",
};
const GRID =
  "grid items-center gap-x-4 px-3 md:grid-cols-[3rem_minmax(0,2.2fr)_5rem_5.5rem_minmax(0,1.2fr)_6rem_7rem_7rem_4.5rem]";

type PendingAction = "publish" | "unpublish";

/** Results for one exam: the ranked board, the publish panel and exports. Publishing issues verifiable certificates. */
export function ResultsView({ examId }: { examId: string }) {
  const [data, setData] = useState<ExamResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Remounts the hold button after a cancelled confirmation, so it can be held again.
  const [holdKey, setHoldKey] = useState(0);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    setError(null);
    api<ExamResults>(`/exams/${examId}/results`)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [examId, version]);

  async function run(kind: PendingAction) {
    setBusy(true);
    try {
      const next = await api<ExamResults>(`/exams/${examId}/results/${kind}`, { method: "POST" });
      setData(next);
      setAction(null);
      setNotice(kind === "publish" ? "Results published. Certificates have been issued." : "Results unpublished. Certificates were revoked.");
    } catch (cause) {
      setAction(null);
      toast.error(describeError(cause, { context: "action" }));
      setVersion((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="grid gap-3 border border-vermilion-deep p-6">
        <p className="text-sm text-vermilion-deep">{error}</p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return <BrailleSpinner label="Loading results" className="m-8 text-ink" />;

  const published = data.resultsPublishedAt !== null;
  const exportCsv = () => downloadCsv(`exam-${examId.slice(0, 8)}-results.csv`, resultsToCsv(data.rows));
  const passed = data.rows.filter((row) => row.passed === true).length;
  const graded = data.rows.filter((row) => row.gradingStatus === "complete").length;

  return (
    <div className="grid gap-10 px-4 py-8 md:px-8">
      <SectionIntro
        eyebrow="Results / 02"
        title={published ? "Published" : "Not published"}
        summary={
          published
            ? `Published ${formatDateTime(data.resultsPublishedAt)}. Candidates can see their results.`
            : `Pass mark ${formatMarks(data.passMarks)} of ${formatMarks(data.totalMarks)}.`
        }
        actions={
          <>
            <Button variant="secondary" size="md" onClick={exportCsv} disabled={data.rows.length === 0}>
              Export CSV
            </Button>
            <Button variant="secondary" size="md" asChild>
              <a href={`/api/reports/exam/${examId}`}>Exam report (PDF)</a>
            </Button>
          </>
        }
      />

      {notice && (
        <p role="status" className="border border-ink p-4 text-sm">
          {notice}
        </p>
      )}

      <StatGrid columns={4}>
        <Stat label="Finalised" value={data.rows.length} focal />
        <Stat label="Passed" value={passed} tone="info" note={data.rows.length ? formatPercent((passed / data.rows.length) * 100) : undefined} />
        <Stat label="Fully graded" value={graded} tone="caution" />
        <Stat label="Pass mark" value={data.passMarks} format={(value) => formatMarks(value)} note={`of ${formatMarks(data.totalMarks)}`} />
      </StatGrid>

      <div className="grid gap-10">
        <section aria-labelledby="results-table" className="grid min-w-0 content-start gap-4">
          <h3 id="results-table" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            <span className="text-cobalt-deep tabular-nums">02</span>
            <span aria-hidden="true" className="text-ink-muted"> / </span>
            Ranked board
          </h3>
          {data.rows.length === 0 ? (
            <EmptyState art="empty-results" eyebrow="No results / 00" title="No finalised attempts yet." description="Rows appear here once a candidate submits and the attempt is finalised." />
          ) : (
            <RankedBoard rows={data.rows} totalMarks={data.totalMarks} />
          )}
        </section>

        <aside aria-labelledby="publish-panel" className="grid content-start gap-5 md:max-w-md">
          <h3 id="publish-panel" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            <span className="text-cobalt-deep tabular-nums">03</span>
            <span aria-hidden="true" className="text-ink-muted"> / </span>
            Publish
          </h3>

          {published ? (
            <div className="grid gap-4 border border-ink p-5">
              <p className="font-medium">Results are live for candidates.</p>
              <p className="text-sm text-ink-soft">Unpublishing revokes the issued certificates. Grades can change again until you publish.</p>
              <div>
                <Button variant="secondary" size="md" onClick={() => setAction("unpublish")}>
                  Unpublish results
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-5 border border-ink p-5">
              <p className="font-medium">{data.canPublish ? "Ready to publish" : "Publishing is blocked"}</p>
              <ul aria-label="Publishing checklist" className="grid gap-2 text-sm">
                {data.canPublish ? (
                  <li className="flex items-start gap-3">
                    <Tick done />
                    <span>Every attempt is finalised and fully graded.</span>
                  </li>
                ) : (
                  data.blockers.map((blocker) => (
                    <li key={blocker} className="flex items-start gap-3">
                      <Tick done={false} />
                      <span>{blocker}</span>
                    </li>
                  ))
                )}
              </ul>
              {data.canPublish ? (
                <>
                  <HoldButton
                    key={holdKey}
                    label="Hold to publish"
                    doneLabel="Publishing"
                    duration={1400}
                    className="h-14 w-full min-w-0"
                    onConfirm={() => setAction("publish")}
                  />
                  <p className="font-mono text-[11px] text-ink-muted">
                    Press and hold, or focus and hold Space. A confirmation follows.
                  </p>
                </>
              ) : (
                <Button size="md" disabled>
                  Publish results
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-3 border-t border-rule pt-5">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Reports</p>
            <p className="text-sm text-ink-soft">Each candidate has a PDF report in the board. The exam report summarises the whole cohort.</p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={action === "publish"}
        title="Publish results"
        confirmLabel="Publish results"
        busy={busy}
        onConfirm={() => void run("publish")}
        onCancel={() => {
          setAction(null);
          setHoldKey((value) => value + 1);
        }}
      >
        <p>Candidates will see their results and verifiable certificates will be issued.</p>
        <p>Grades can only be changed after results are unpublished.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={action === "unpublish"}
        title="Unpublish results"
        confirmLabel="Unpublish results"
        tone="danger"
        busy={busy}
        onConfirm={() => void run("unpublish")}
        onCancel={() => setAction(null)}
      >
        <p>Candidates will stop seeing their results and the issued certificates will be revoked.</p>
        <p>You can publish again afterwards, and new certificates will be issued.</p>
      </ConfirmDialog>
    </div>
  );
}

/** A checkbox-like mark that draws its tick in when the item is done. */
function Tick({ done }: { done: boolean }) {
  return (
    <span aria-hidden="true" className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center border", done ? "border-cobalt bg-cobalt" : "border-amber")}>
      {done ? (
        <svg viewBox="0 0 12 12" className="size-3 text-paper">
          <path d="M2 6.5 L4.8 9 L10 3" fill="none" stroke="currentColor" strokeWidth="1.8" pathLength={1} strokeDasharray="1" strokeDashoffset="0" />
        </svg>
      ) : null}
    </span>
  );
}

/** The results ranked by total score. Rows glide to their rank when the board changes. */
function RankedBoard({ rows, totalMarks }: { rows: ResultRow[]; totalMarks: number }) {
  const reduced = useReducedMotion() ?? false;
  const ranked = useMemo(
    () =>
      [...rows].sort((a, b) => (b.totalScore ?? -1) - (a.totalScore ?? -1) || a.displayName.localeCompare(b.displayName)),
    [rows],
  );

  return (
    <div className="overflow-x-auto border border-ink">
      <div role="table" aria-label="Ranked results" className="min-w-[860px]">
        <div role="row" className={cn(GRID, "h-11 border-b border-ink bg-paper-sunk font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase")}>
          <span role="columnheader">#</span>
          <span role="columnheader">Candidate</span>
          <span role="columnheader" className="text-right">Score</span>
          <span role="columnheader">Percent</span>
          <span role="columnheader">Result</span>
          <span role="columnheader">Grading</span>
          <span role="columnheader">Review</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">
            <span className="sr-only">Report</span>
          </span>
        </div>
        {ranked.map((row, index) => (
          <motion.div
            key={row.attemptId}
            role="row"
            layout={reduced ? false : "position"}
            transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.8 }}
            className={cn(GRID, "min-h-14 border-b border-rule bg-paper py-2 hover:bg-paper-raised")}
          >
            <span role="cell" className="font-mono text-xs text-ink-muted tabular-nums">
              {index + 1}
            </span>
            <span role="cell" className="grid min-w-0">
              <span className="truncate font-medium">{row.displayName}</span>
              <span className="truncate font-mono text-[11px] text-ink-muted">{row.email}</span>
            </span>
            <span role="cell" className="text-right font-mono tabular-nums">
              {formatMarks(row.totalScore)}
              <span className="block text-[11px] text-ink-muted">of {formatMarks(totalMarks)}</span>
            </span>
            <span role="cell" className="grid min-w-0 gap-1.5">
              <Meter
                value={row.percent ?? 0}
                max={100}
                tone={row.passed === false ? "muted" : row.passed === true ? "info" : "caution"}
                label={`${row.displayName}: ${formatPercent(row.percent, 1)}`}
                valueText={formatPercent(row.percent, 1)}
              />
              <span className="font-mono text-[11px] tabular-nums">{formatPercent(row.percent, 1)}</span>
            </span>
            <span role="cell">
              {row.passed === null ? (
                <Badge tone="dashed" size="sm">Pending</Badge>
              ) : row.passed ? (
                <Badge tone="info" size="sm">Pass</Badge>
              ) : (
                <Badge tone="muted" size="sm">Fail</Badge>
              )}
            </span>
            <span role="cell">
              <Badge tone={GRADING_TONE[row.gradingStatus]} size="sm">
                {GRADING[row.gradingStatus]}
              </Badge>
            </span>
            <span role="cell">
              <PriorityChip priority={row.reviewPriority} />
            </span>
            <span role="cell" className="font-mono text-[11px] text-ink-soft">
              {STATUS[row.status]}
            </span>
            <span role="cell">
              <a
                href={`/api/reports/attempt/${row.attemptId}`}
                className="font-mono text-[11px] tracking-[0.1em] uppercase underline underline-offset-4 hover:text-vermilion-deep"
              >
                PDF<span className="sr-only"> for {row.displayName}</span>
              </a>
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
