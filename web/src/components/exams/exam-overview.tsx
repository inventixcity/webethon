"use client";

import { useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { messageFor } from "@/lib/errors/describe";
import type { Exam } from "@/lib/exam/types";
import { ConfirmDialog } from "./confirm-dialog";
import { ExamForm } from "./exam-form";
import { completeExam, unpublishExam } from "./actions";
import { formatWindow, notifyExamChanged, STATUS_LABEL } from "./format";
import { PhaseChip } from "./phase-chip";
import { ErrorState, LoadingState } from "./states";
import { useExam } from "./use-resource";

/** The Overview tab: the exam form, plus the lifecycle actions and a short status summary. */
export function ExamOverview({ examId }: { examId: string }) {
  const { data: exam, loading, error, reload } = useExam(examId);

  if (loading && !exam) return <LoadingState label="Loading exam details" rows={4} />;
  if (!exam) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="grid gap-12 py-10 md:grid-cols-12">
      <div className="min-w-0 md:col-span-8">
        <ExamForm key={exam.version} mode="edit" exam={exam} />
      </div>
      <aside aria-label="Exam status" className="grid content-start gap-10 md:col-span-3 md:col-start-10">
        <StatusPanel exam={exam} />
        <Lifecycle exam={exam} />
      </aside>
    </div>
  );
}

function StatusPanel({ exam }: { exam: Exam }) {
  const rows: Array<{ label: string; value: string | number }> = [
    { label: "Status", value: STATUS_LABEL[exam.status] },
    { label: "Questions", value: exam.questionCount },
    { label: "Enrolled", value: exam.enrolledCount },
    { label: "Attempts", value: exam.attemptCount },
    { label: "Marks", value: `${exam.totalMarks} total / ${exam.passMarks} to pass` },
  ];
  return (
    <div className="grid gap-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">01 / Status</p>
      <div className="flex flex-wrap items-center gap-3">
        <PhaseChip phase={exam.phase} />
      </div>
      <p className="text-sm text-ink-soft">{formatWindow(exam.startsAt, exam.endsAt)}</p>
      <dl className="grid border-t border-rule">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-rule py-3">
            <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{row.label}</dt>
            <dd className="text-right text-sm">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Lifecycle({ exam }: { exam: Exam }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<"complete" | "unpublish" | null>(null);
  const [pending, setPending] = useState(false);

  // Complete is offered for a published exam. Before the window closes, the server needs force=true.
  const windowClosed = exam.phase === "closed";
  const published = exam.status === "published";
  const hasAttempts = exam.attemptCount > 0;

  async function run(action: "complete" | "unpublish") {
    setPending(true);
    try {
      if (action === "complete") {
        await completeExam(exam.id, !windowClosed);
        toast.success("Exam marked as completed.");
      } else {
        await unpublishExam(exam.id);
        toast.success("Returned to draft. You can edit and publish it again.");
      }
      setDialog(null);
      notifyExamChanged(exam.id);
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">02 / Lifecycle</p>

      {exam.status === "draft" ? (
        <p className="text-sm text-ink-soft">
          This exam is a draft. Assign the paper and enrol candidates, then publish from the Review tab.
        </p>
      ) : null}

      {published ? (
        <div className="grid gap-3">
          <Button variant="secondary" className="w-full justify-center" onClick={() => setDialog("complete")}>
            Complete exam
          </Button>
          <p className="text-sm text-ink-muted">
            {windowClosed
              ? "The window has closed. Completing marks the exam finished so results can be published."
              : "Completing before the end ends the exam for candidates who have not submitted."}
          </p>
          <Button
            variant="ghost"
            className="w-fit"
            disabled={hasAttempts}
            onClick={() => setDialog("unpublish")}
          >
            Unpublish
          </Button>
          {hasAttempts ? (
            <p className="text-sm text-ink-muted">
              Unpublish is unavailable because {exam.attemptCount} attempt{exam.attemptCount === 1 ? " has" : "s have"} started.
            </p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === "complete"}
        title="Complete this exam?"
        confirmLabel="Complete exam"
        pending={pending}
        onCancel={() => setDialog(null)}
        onConfirm={() => run("complete")}
      >
        <p>
          {windowClosed
            ? "Candidates can no longer start or continue. You can then publish results from the Results tab."
            : "The window is still open. Candidates who have not submitted will be cut off now. This cannot be undone."}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "unpublish"}
        title="Return this exam to draft?"
        confirmLabel="Unpublish"
        destructive
        pending={pending}
        onCancel={() => setDialog(null)}
        onConfirm={() => run("unpublish")}
      >
        <p>The frozen paper is removed and the exam becomes editable again. Candidates will not see it until you publish again.</p>
      </ConfirmDialog>
    </div>
  );
}
