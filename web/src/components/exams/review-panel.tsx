"use client";

import { Check, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BarChart } from "@/components/charts";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { messageFor } from "@/lib/errors/describe";
import type { ExamReview, QuestionKind } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { createSandboxAttempt, publishExam } from "./actions";
import { ConfirmDialog } from "./confirm-dialog";
import { formatWindow, notifyExamChanged, STATUS_LABEL } from "./format";
import { PhaseChip } from "./phase-chip";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { useExam, useResource } from "./use-resource";

const KIND_LABEL: Record<QuestionKind, string> = { single: "Single choice", multi: "Multiple choice", written: "Written" };

/** The Review tab: a readiness checklist, mark totals, topic and difficulty mix, a full paper preview, and publish. */
export function ReviewPanel({ examId }: { examId: string }) {
  const { data: exam, loading: examLoading, error: examError, reload: reloadExam } = useExam(examId);
  const review = useResource<ExamReview>(`/exams/${encodeURIComponent(examId)}/review`, exam?.version ?? null);
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  if (examLoading && !exam) return <LoadingState label="Loading review" rows={4} />;
  if (!exam) return <ErrorState error={examError} onRetry={reloadExam} />;

  async function publish() {
    setPublishing(true);
    try {
      await publishExam(exam!.id);
      toast.success("Published. The paper is now frozen.");
      setConfirming(false);
      notifyExamChanged(exam!.id);
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setPublishing(false);
    }
  }

  async function preview() {
    setPreviewing(true);
    try {
      const attemptId = await createSandboxAttempt(exam!.id);
      router.push(`/exam/${attemptId}`);
    } catch (cause) {
      toast.error(messageFor(cause));
      setPreviewing(false);
    }
  }

  const isDraft = exam.status === "draft";
  const data = review.data;
  const canPublish = isDraft && data !== null && data.ready;

  return (
    <div className="grid gap-16 py-10">
      <section aria-labelledby="review-status" className="grid gap-6 md:grid-cols-12">
        <div className="grid content-start gap-4 md:col-span-7">
          <h2 id="review-status" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            01 / Readiness
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <PhaseChip phase={exam.phase} />
            <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{STATUS_LABEL[exam.status]}</span>
          </div>
          <p className="text-sm text-ink-soft">{formatWindow(exam.startsAt, exam.endsAt)}</p>
        </div>
        <div className="flex flex-wrap items-start gap-3 md:col-span-5 md:justify-end">
          <Button variant="secondary" loading={previewing} onClick={preview}>
            Preview as candidate
          </Button>
          {isDraft ? (
            <Button disabled={!canPublish} onClick={() => setConfirming(true)}>
              Publish paper
            </Button>
          ) : null}
        </div>
      </section>

      {!isDraft ? (
        <p className="grid max-w-prose gap-2 border-l-2 border-ink pl-5 text-ink-soft">
          <span className="font-mono text-[11px] tracking-[0.14em] text-ink uppercase">Already published</span>
          This paper is frozen. Follow the exam on the{" "}
          <Link href={`/app/examiner/exams/${encodeURIComponent(exam.id)}/monitor`} className="underline underline-offset-4 hover:text-ink">
            Monitor tab
          </Link>
          .
        </p>
      ) : null}

      <section aria-labelledby="checklist-heading" className="grid gap-6">
        <h2 id="checklist-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
          Checklist
        </h2>
        {review.loading ? <LoadingState label="Running checks" rows={3} /> : null}
        {!review.loading && review.error ? <ErrorState error={review.error} onRetry={review.reload} /> : null}
        {!review.loading && data ? (
          <>
            <ul className="grid">
              {data.checks.map((check) => (
                <CheckRow key={check.key} check={check} />
              ))}
            </ul>
            {!data.ready ? (
              <p role="status" className="text-sm text-ink-soft">
                Fix the items marked Fix before publishing. Notes don&apos;t block publishing.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {data ? (
        <section aria-labelledby="marks-heading" className="grid gap-6">
          <h2 id="marks-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
            02 / Marks
          </h2>
          <MarksBar assigned={data.marksAssigned} total={exam.totalMarks} />
        </section>
      ) : null}

      {data ? (
        <section aria-labelledby="mix-heading" className="grid gap-8">
          <h2 id="mix-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
            03 / Mix
          </h2>
          <div className="grid gap-12 md:grid-cols-2">
            <BarChart
              label="Questions by topic"
              data={data.topicMix.map((entry) => ({ key: entry.topic, value: entry.count }))}
              formatValue={(value) => `${value} questions`}
            />
            <BarChart
              label="Questions by difficulty"
              data={data.difficultyMix.map((entry) => ({ key: `D${entry.difficulty}`, value: entry.count }))}
              formatValue={(value) => `${value} questions`}
            />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="paper-heading" className="grid gap-6">
        <h2 id="paper-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
          04 / Paper preview <span className="text-ink-muted">(answer keys visible to you only)</span>
        </h2>
        {exam.questions.length === 0 ? (
          <EmptyState title="The paper is empty.">Add questions on the Questions tab before reviewing.</EmptyState>
        ) : (
          <ol aria-label="Paper with answer keys" className="grid">
            {exam.questions.map((item, index) => (
              <li key={`${index}-${item.question.id}`} className="grid gap-4 border-b border-rule py-6 md:grid-cols-[3rem_1fr]">
                <span className="font-mono text-sm text-ink-muted tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <div className="grid min-w-0 gap-4">
                  <p className="text-base leading-relaxed break-words">{item.question.stem}</p>
                  <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    {item.marks} marks / {KIND_LABEL[item.question.kind]} / {item.question.topic} / D{item.question.difficulty}
                  </p>
                  {item.question.kind === "written" ? (
                    <p className="text-sm text-ink-soft">
                      <span className="font-mono text-[11px] tracking-[0.12em] uppercase">Rubric: </span>
                      {item.question.rubric || "No rubric written."}
                    </p>
                  ) : (
                    <ul className="grid gap-2">
                      {item.question.options.map((option, index) => {
                        const correct = item.question.correct.includes(option.id);
                        return (
                          <li key={option.id} className={cn("flex items-start gap-3 text-sm", correct ? "text-ink" : "text-ink-soft")}>
                            <span className="font-mono text-[11px] tracking-[0.12em] uppercase">{String.fromCharCode(65 + index)}.</span>
                            <span className="min-w-0 break-words">{option.text}</span>
                            {correct ? <span className="ml-auto shrink-0 border border-ink px-2 font-mono text-[11px] tracking-[0.12em] uppercase">Key</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {item.question.explanation ? <p className="text-sm text-ink-muted">{item.question.explanation}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title="Publish and freeze this paper?"
        confirmLabel="Publish paper"
        pending={publishing}
        onCancel={() => setConfirming(false)}
        onConfirm={publish}
      >
        <p>Once published, the questions, marks and candidate rules are frozen. Candidates see this exact paper when the window opens.</p>
        <p>After that, only the title, instructions and end time can change, and the end time can only be extended.</p>
      </ConfirmDialog>
    </div>
  );
}

function CheckRow({ check }: { check: ExamReview["checks"][number] }) {
  // A failed candidates check is a note: it never blocks publishing.
  const note = !check.ok && check.key === "candidates";
  const label = check.ok ? "Pass" : note ? "Note" : "Fix";
  return (
    <li className="grid grid-cols-[auto_1fr] items-start gap-4 border-b border-rule py-4">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-6 place-items-center border",
          check.ok ? "border-ink bg-ink text-paper" : "border-ink text-ink",
        )}
      >
        {check.ok ? <Check className="size-4" strokeWidth={3} /> : <X className="size-4" strokeWidth={3} />}
      </span>
      <div className="grid gap-1">
        <p className="font-mono text-[11px] tracking-[0.12em] uppercase">
          <span className="sr-only">{label}: </span>
          <span className={check.ok ? "text-ink" : "text-ink-muted"}>{label}</span>
        </p>
        <p className="text-base text-ink-soft">{check.message}</p>
      </div>
    </li>
  );
}

function MarksBar({ assigned, total }: { assigned: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (assigned / total) * 100)) : 0;
  const exact = Math.round(assigned * 100) === Math.round(total * 100);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4 font-mono text-[11px] tracking-[0.12em] uppercase">
        <span>
          {assigned} of {total} marks assigned
        </span>
        <span className="text-ink-muted">{exact ? "Matches exam total" : "Does not match exam total"}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Marks assigned"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(assigned, total)}
        aria-valuetext={`${assigned} of ${total} marks`}
        className="h-2 w-full bg-paper-sunk"
      >
        <div className="h-full bg-ink transition-[width] duration-(--duration-base) ease-(--ease-enter) motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
