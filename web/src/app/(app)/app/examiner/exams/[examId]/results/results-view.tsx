"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamResults, ResultRow } from "@/lib/exam/types";
import { describeError } from "@/lib/errors/describe";
import { useToast } from "@/components/feedback/toaster";
import { ConfirmDialog } from "@/components/monitor/confirm-dialog";
import { PriorityChip } from "@/components/monitor/priority-chip";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatMarks, formatPercent, messageOf } from "@/components/analytics/format";
import { downloadCsv, resultsToCsv } from "./csv";

const STATUS: Record<ResultRow["status"], string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Expired",
};
const GRADING: Record<ResultRow["gradingStatus"], string> = { pending: "Pending", partial: "Partial", complete: "Complete" };

type PendingAction = "publish" | "unpublish";

/** Results for one exam: publication, the table, and exports. Publishing issues verifiable certificates. */
export function ResultsView({ examId }: { examId: string }) {
  const [data, setData] = useState<ExamResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
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

  return (
    <div className="grid gap-10 px-4 py-8 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-ink pb-6">
        <div className="grid gap-3">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Results</p>
          <h2 className="text-3xl leading-none font-semibold tracking-tight md:text-4xl">
            {published ? "Published" : "Not published"}
          </h2>
          <p className="font-mono text-xs text-ink-soft">
            {published
              ? `Published ${formatDateTime(data.resultsPublishedAt)}. Candidates can see their results.`
              : `Pass mark ${formatMarks(data.passMarks)} of ${formatMarks(data.totalMarks)}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {published ? (
            <Button variant="secondary" size="md" onClick={() => setAction("unpublish")}>
              Unpublish results
            </Button>
          ) : (
            <Button size="md" disabled={!data.canPublish} onClick={() => setAction("publish")}>
              Publish results
            </Button>
          )}
          <Button variant="secondary" size="md" onClick={exportCsv} disabled={data.rows.length === 0}>
            Export CSV
          </Button>
          <Button variant="link" size="md" asChild>
            <a href={`/api/reports/exam/${examId}`}>Download exam report (PDF)</a>
          </Button>
        </div>
      </header>

      {notice && (
        <p role="status" className="border border-ink p-4 text-sm">
          {notice}
        </p>
      )}

      {!published && (
        <section aria-labelledby="publish-checks" className="grid gap-4">
          <h3 id="publish-checks" className="font-mono text-[11px] tracking-[0.12em] uppercase">
            {data.canPublish ? "Ready to publish" : "Publishing is blocked"}
          </h3>
          {!data.canPublish && data.blockers.length > 0 && (
            <ul className="grid gap-2 border-l-2 border-ink pl-4 text-sm">
              {data.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="results-table" className="grid gap-4">
        <h3 id="results-table" className="sr-only">
          Candidate results
        </h3>
        {data.rows.length === 0 ? (
          <p className="border border-rule p-6 text-ink-muted">No finalized attempts yet.</p>
        ) : (
          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[960px] text-left text-sm">
              <caption className="sr-only">
                Results for each candidate: marks, percent, pass or fail, grading status and review priority.
              </caption>
              <thead className="bg-paper-sunk">
                <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                  <th scope="col" className="px-3 py-3 font-medium">Candidate</th>
                  <th scope="col" className="px-3 py-3 font-medium">Status</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Auto</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Manual</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Total</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Percent</th>
                  <th scope="col" className="px-3 py-3 font-medium">Result</th>
                  <th scope="col" className="px-3 py-3 font-medium">Grading</th>
                  <th scope="col" className="px-3 py-3 font-medium">Review</th>
                  <th scope="col" className="px-3 py-3 font-medium">Report</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.attemptId} className="border-t border-rule align-top">
                    <th scope="row" className="px-3 py-3 font-normal">
                      <span className="block font-medium">{row.displayName}</span>
                      <span className="block font-mono text-[11px] break-all text-ink-muted">{row.email}</span>
                    </th>
                    <td className="px-3 py-3 whitespace-nowrap">{STATUS[row.status]}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMarks(row.autoScore)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMarks(row.manualScore)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMarks(row.totalScore)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatPercent(row.percent, 1)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {row.passed === null ? "—" : row.passed ? "Pass" : "Fail"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{GRADING[row.gradingStatus]}</td>
                    <td className="px-3 py-3">
                      <PriorityChip priority={row.reviewPriority} />
                    </td>
                    <td className="px-3 py-3">
                      <a
                        href={`/api/reports/attempt/${row.attemptId}`}
                        className="underline underline-offset-4 hover:text-vermilion-deep"
                      >
                        PDF<span className="sr-only"> for {row.displayName}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={action === "publish"}
        title="Publish results"
        confirmLabel="Publish results"
        busy={busy}
        onConfirm={() => void run("publish")}
        onCancel={() => setAction(null)}
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
