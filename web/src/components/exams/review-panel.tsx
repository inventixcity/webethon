"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Info, X } from "lucide-react";
import { BarChart } from "@/components/charts";
import { useToast } from "@/components/feedback/toaster";
import { DifficultySquares, KindChip } from "@/components/questions/parts";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import { messageFor } from "@/lib/errors/describe";
import type { ExamReview } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { SectionIntro } from "./section-intro";
import { createSandboxAttempt, publishExam } from "./actions";
import { ConfirmDialog } from "./confirm-dialog";
import { formatWindow, notifyExamChanged, PHASE_LABEL, STATUS_LABEL } from "./format";
import { PhaseChip } from "./phase-chip";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { useExam, useResource } from "./use-resource";


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
  const passedCount = data?.checks.filter((check) => check.ok).length ?? 0;
  const noteCount = data?.checks.filter((check) => !check.ok && check.key === "candidates").length ?? 0;
  const fixCount = data ? data.checks.length - passedCount - noteCount : 0;
  const firstBlocker = data?.checks.find((check) => !check.ok && check.key !== "candidates");

  return (
    <div className="grid gap-10 py-8 sm:gap-14 sm:py-10">
      <SectionIntro
        eyebrow="Review / 05"
        title="Review and publish"
        summary="Check the paper against the rules before you freeze it. Publishing locks questions and marks."
      />
      <section aria-labelledby="review-status" className="grid gap-5 border border-ink bg-paper-raised p-4 sm:p-5 md:grid-cols-12">
        <div className="grid content-start gap-3 md:col-span-5">
          <h2 id="review-status" className="font-mono text-[11px] font-bold tracking-[0.14em] uppercase">
            Readiness
          </h2>
          <p aria-live="polite" className="font-mono text-xs font-bold tracking-[0.06em] text-ink">
            {review.loading && !data ? "Checking paper…" : `${fixCount} to fix · ${noteCount} note${noteCount === 1 ? "" : "s"} · ${passedCount} passed`}
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <PhaseChip phase={exam.phase} />
            {STATUS_LABEL[exam.status].toLowerCase() !== PHASE_LABEL[exam.phase].toLowerCase() ? (
              <span className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">{STATUS_LABEL[exam.status]}</span>
            ) : null}
          </div>
          <p className="text-sm text-ink-soft">{formatWindow(exam.startsAt, exam.endsAt)}</p>
        </div>
        {isDraft ? (
          <div className="grid min-w-0 gap-3 md:col-span-7 md:justify-items-end">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap md:justify-end">
            <Button className="w-full sm:w-auto" variant="secondary" loading={previewing} onClick={preview}>Preview as candidate</Button>
            {canPublish ? (
              <Button className="w-full sm:w-auto" onClick={() => setConfirming(true)}>Publish paper</Button>
            ) : (
              <Button className="w-full sm:w-auto" disabled aria-describedby="publish-blocker">Publish paper</Button>
            )}
            </div>
            {!canPublish ? <p id="publish-blocker" className="max-w-[44ch] text-sm text-vermilion-deep md:text-right">{firstBlocker?.message ?? (review.error ? "Readiness checks could not load. Retry the checks before publishing." : "Run the readiness checks before publishing.")}</p> : null}
          </div>
        ) : null}
      </section>

      {!isDraft ? (
        <section aria-label="Published exam actions" className="grid gap-5 border border-cobalt bg-paper-raised p-5 sm:flex sm:items-center sm:justify-between sm:p-6">
          <div className="grid gap-2"><p className="font-mono text-[11px] tracking-[0.14em] text-cobalt-deep uppercase">Published · paper frozen</p><p className="text-sm text-ink-soft">Candidates receive this fixed question set and mark scheme.</p></div>
          <div className="flex flex-wrap gap-3"><Button asChild variant="secondary"><Link href={`/app/examiner/exams/${encodeURIComponent(exam.id)}/monitor`}>Open monitor</Link></Button><Button variant="secondary" loading={previewing} onClick={preview}>Preview as candidate</Button></div>
        </section>
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
          <div className="border border-rule bg-paper-raised p-4 sm:p-5"><MarksBar assigned={data.marksAssigned} total={exam.totalMarks} /></div>
        </section>
      ) : null}

      {data ? (
        <section aria-labelledby="mix-heading" className="grid gap-8">
          <h2 id="mix-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
            03 / Mix
          </h2>
          {exam.questions.length === 0 ? (
            <p className="border border-rule bg-paper-raised p-4 text-sm text-ink-soft sm:p-5">Add questions to see the topic and difficulty breakdown. <Link className="font-medium text-cobalt-deep underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-focus" href={`/app/examiner/exams/${encodeURIComponent(examId)}/questions`}>Go to Questions</Link></p>
          ) : <div className="grid gap-8 md:grid-cols-2">
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
          </div>}
        </section>
      ) : null}

      <section aria-labelledby="paper-heading" className="grid gap-6">
        <h2 id="paper-heading" className="border-b border-ink pb-4 font-mono text-[11px] tracking-[0.14em] uppercase">
          04 / Paper preview <span className="text-ink-muted">(answer keys visible to you only)</span>
        </h2>
        {exam.questions.length === 0 ? (
          <EmptyState art="empty-questions" title="The paper is empty.">Add questions on the Questions tab before reviewing.</EmptyState>
        ) : (
          <ol aria-label="Paper with answer keys" className="grid">
            {exam.questions.map((item, index) => (
              <li key={`${index}-${item.question.id}`} className="grid gap-4 border-b border-rule py-6 md:grid-cols-[3rem_1fr]">
                <span className="font-mono text-sm text-ink-muted tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <div className="grid min-w-0 gap-4">
                  <p className="text-base leading-relaxed break-words">{item.question.stem}</p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    <span className="tabular-nums">{item.marks} marks</span>
                    <span>{item.question.topic}</span>
                    <DifficultySquares value={item.question.difficulty} />
                    <KindChip kind={item.question.kind} />
                  </div>
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
        onCancel={() => {
          setConfirming(false);
        }}
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
    <li className="grid grid-cols-[auto_1fr] items-start gap-3 border-b border-rule py-4 sm:gap-4">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-6 place-items-center border",
          check.ok ? "border-cobalt bg-cobalt text-paper" : note ? "border-amber bg-amber/15 text-amber-deep" : "border-vermilion bg-vermilion/10 text-vermilion-deep",
        )}
      >
        {check.ok ? <Check aria-hidden="true" className="size-4" strokeWidth={3} /> : note ? <Info aria-hidden="true" className="size-4" /> : <X aria-hidden="true" className="size-4" strokeWidth={3} />}
      </span>
      <div className="grid gap-1">
        <p className="font-mono text-[11px] tracking-[0.12em] uppercase">
          <span className="sr-only">{label}: </span>
          <span className={check.ok ? "text-cobalt-deep" : note ? "text-amber-deep" : "text-vermilion-deep"}>{label}</span>
        </p>
        <p className="text-base text-ink-soft">{check.message}</p>
      </div>
    </li>
  );
}

function MarksBar({ assigned, total }: { assigned: number; total: number }) {
  const exact = Math.round(assigned * 100) === Math.round(total * 100);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4 font-mono text-[11px] tracking-[0.12em] uppercase">
        <span className="tabular-nums">
          {assigned} of {total} marks assigned
        </span>
        <span className={exact ? "text-cobalt-deep" : "text-amber-deep"}>{exact ? "Matches exam total" : "Does not match exam total"}</span>
      </div>
      <Meter
        value={Math.min(assigned, total)}
        max={Math.max(total, 1)}
        tone={exact ? "info" : "caution"}
        size="md"
        label="Marks assigned"
        valueText={`${assigned} of ${total} marks`}
      />
    </div>
  );
}
