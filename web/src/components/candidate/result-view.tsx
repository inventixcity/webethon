"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ApiError } from "@/lib/api/client";
import { RaiseDisputeDialog, type DisputeTarget } from "@/components/disputes/raise-dispute-dialog";
import { QuestionDispute } from "@/components/disputes/question-dispute";
import { disputeWindowEnd, formatDay } from "@/components/disputes/format";
import type { AnswerResponse, CandidateResult, Dispute, QuestionOption } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { describeError, formatDateTime } from "./format";
import { PanelError, PanelLoading } from "./notice";
import { useApiData } from "./use-api-data";

const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function optionText(id: string, options: QuestionOption[]): string {
  return options.find((option) => option.id === id)?.text ?? id;
}

/** What the candidate answered, in words. Objective answers show option text; written answers show the text. */
function answerText(response: AnswerResponse | null, options: QuestionOption[]): string {
  if (!response) return "No answer";
  if ("text" in response) return response.text.trim() || "No answer";
  if (response.selected.length === 0) return "No answer";
  return response.selected.map((id) => optionText(id, options)).join(", ");
}

function correctText(correct: string[] | null, options: QuestionOption[]): string {
  if (!correct) return "Shown in feedback";
  if (correct.length === 0) return "Marked by an examiner";
  return correct.map((id) => optionText(id, options)).join(", ");
}

type Breakdown = NonNullable<CandidateResult["breakdown"]>[number];
/** The server may send each question's id. It is needed to raise a dispute; without it no action is offered. */
type BreakdownItem = Breakdown & { itemId?: string };

function BreakdownRows({ item, voided, dispute, windowEnd, now, verifyCode, onRaise }: {
  item: BreakdownItem;
  voided: boolean;
  dispute: Dispute | undefined;
  windowEnd: number;
  now: number;
  verifyCode: string;
  onRaise: (target: DisputeTarget) => void;
}) {
  return (
    <>
      <tr className="align-top">
        <td className="py-4 pr-4 font-mono text-[11px] tracking-[0.12em] tabular-nums">{item.position}</td>
        <td className="max-w-[40ch] py-4 pr-4">
          <span className="block font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            {item.kind} · {item.marks} marks
          </span>
          <span className="mt-1 block whitespace-pre-wrap">{item.stem}</span>
        </td>
        <td className="py-4 pr-4 whitespace-pre-wrap">{answerText(item.response, item.options)}</td>
        <td className="py-4 pr-4 whitespace-pre-wrap">{correctText(item.correct, item.options)}</td>
        <td className="py-4 font-mono text-[11px] tracking-[0.12em] tabular-nums whitespace-nowrap">
          {voided ? (
            <span className="font-sans tracking-normal normal-case">Voided after review</span>
          ) : (
            <>
              {item.awarded} / {item.marks}
            </>
          )}
        </td>
      </tr>
      {(item.feedback || item.explanation) && (
        <tr>
          <td />
          <td colSpan={4} className="pb-6 text-sm text-ink-soft">
            {item.feedback && <p className="whitespace-pre-wrap">Feedback: {item.feedback}</p>}
            {item.explanation && <p className="mt-2 whitespace-pre-wrap">Explanation: {item.explanation}</p>}
          </td>
        </tr>
      )}
      <QuestionDispute
        dispute={dispute}
        itemId={item.itemId}
        windowEnd={windowEnd}
        now={now}
        verifyCode={verifyCode}
        onRaise={() => {
          if (item.itemId) onRaise({ itemId: item.itemId, position: item.position });
        }}
      />
    </>
  );
}

export function ResultView({ attemptId }: { attemptId: string }) {
  const { state, reload } = useApiData<CandidateResult>(`/me/results/${attemptId}`);
  const disputes = useApiData<Dispute[]>("/me/disputes");
  const [raising, setRaising] = useState<DisputeTarget | null>(null);

  if (state.status === "loading") return <PanelLoading label="Loading your result" />;
  if (state.status === "error") {
    return (
      <div className="grid gap-6">
        <PanelError title="We couldn't load this result." message={describeError(state.error)} onRetry={reload} />
        <Link
          href="/app/candidate"
          className="w-fit font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4"
        >
          Back to my exams
        </Link>
      </div>
    );
  }

  const result = state.data;
  const percent = percentFormat.format(result.percent);
  const windowEnd = disputeWindowEnd(result.publishedAt);
  // The page renders only after the result arrives on the client, so reading the clock here cannot mismatch the server.
  const now = Date.now();
  const windowOpen = now < windowEnd;
  const myDisputes = disputes.state.status === "ready" ? disputes.state.data.filter((d) => d.attemptId === attemptId) : [];
  const disputeByPosition = new Map(myDisputes.map((d) => [d.position, d]));

  return (
    <div className="grid gap-14">
      <PageHeader
        index="03"
        eyebrow="Your result"
        banner="bg-results"
        title={result.examTitle}
        breadcrumb={[{ label: "My exams", href: "/app/candidate" }, { label: "Result" }]}
      />

      <section aria-labelledby="score" className="grid gap-8 border-y border-ink py-10 md:grid-cols-[auto_minmax(0,1fr)] md:gap-16">
        <h2 id="score" className="sr-only">
          Score
        </h2>
        <p className="flex items-baseline gap-2 text-[clamp(4.5rem,16vw,9rem)] leading-none font-semibold tracking-[-0.05em] tabular-nums">
          <span>{percent}</span>
          <span className="text-[0.3em] tracking-normal">%</span>
        </p>
        <div className="grid content-center gap-5">
          <span
            className={cn(
              "inline-flex w-fit items-center border px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase",
              result.passed ? "border-ink bg-ink text-paper" : "border-ink-muted text-ink-soft",
            )}
          >
            {result.passed ? "Passed" : "Not passed"}
          </span>
          <dl className="grid gap-4 font-mono text-[11px] tracking-[0.12em] uppercase sm:grid-cols-3">
            <div className="grid gap-1">
              <dt className="text-ink-muted">Score</dt>
              <dd className="normal-case tracking-normal tabular-nums">
                {result.totalScore} of {result.totalMarks} marks
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-ink-muted">Pass mark</dt>
              <dd className="normal-case tracking-normal tabular-nums">{result.passMarks} marks</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-ink-muted">Submitted</dt>
              <dd className="normal-case tracking-normal">
                {result.submittedAt ? formatDateTime(result.submittedAt) : "Not recorded"}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="verify" className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:gap-10">
        <div className="grid gap-3">
          <h2 id="verify" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            Verification code
          </h2>
          <p className="font-mono text-lg tracking-[0.12em] break-all">{result.verifyCode}</p>
          <p className="max-w-[60ch] text-sm text-ink-soft">
            Anyone can check this result with the code. The check shows the exam, the masked candidate name, the
            score and whether the certificate is valid. It needs no account.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary">
            <Link href={`/verify/${encodeURIComponent(result.verifyCode)}`}>Check this result</Link>
          </Button>
          <Button asChild>
            <a href={`/api/reports/attempt/${encodeURIComponent(attemptId)}`}>Download PDF</a>
          </Button>
        </div>
      </section>

      <section aria-labelledby="breakdown" className="grid gap-5">
        <div className="grid gap-3">
          <h2 id="breakdown" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            Question breakdown
          </h2>
          {result.breakdown !== null && result.breakdown.length > 0 ? (
            <p className="max-w-[62ch] text-sm text-ink-soft" aria-live="polite">
              {windowOpen
                ? `You can dispute one mark per question until ${formatDay(new Date(windowEnd).toISOString())}. Your examiner decides each one, and the decision is recorded.`
                : `The dispute window closed on ${formatDay(new Date(windowEnd).toISOString())}.`}
            </p>
          ) : null}
          {disputes.state.status === "error" && !(disputes.state.error instanceof ApiError && disputes.state.error.status === 404) ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-vermilion-deep">
              <span>We couldn&apos;t load your disputes.</span>
              <Button type="button" variant="secondary" size="sm" onClick={disputes.reload}>
                Try again
              </Button>
            </div>
          ) : null}
        </div>

        {result.breakdown === null ? (
          <p className="border-t border-rule py-8 text-base text-ink-soft">
            Your institution has chosen not to show the question breakdown for this exam.
          </p>
        ) : result.breakdown.length === 0 ? (
          <p className="border-t border-rule py-8 text-base text-ink-soft">This exam has no questions to show.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">Your answers, the correct answers and the marks awarded for each question</caption>
              <thead>
                <tr className="border-y border-ink font-mono text-[11px] tracking-[0.12em] uppercase">
                  <th scope="col" className="py-3 pr-4 font-medium">No.</th>
                  <th scope="col" className="py-3 pr-4 font-medium">Question</th>
                  <th scope="col" className="py-3 pr-4 font-medium">Your answer</th>
                  <th scope="col" className="py-3 pr-4 font-medium">Correct answer</th>
                  <th scope="col" className="py-3 font-medium">Awarded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {result.breakdown.map((item: BreakdownItem) => {
                  const dispute = disputeByPosition.get(item.position);
                  return (
                    <BreakdownRows
                      key={item.position}
                      item={item}
                      voided={dispute?.status === "accepted" && dispute.resolution === "void_item"}
                      dispute={dispute}
                      windowEnd={windowEnd}
                      now={now}
                      verifyCode={result.verifyCode}
                      onRaise={setRaising}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {raising ? (
        <RaiseDisputeDialog
          attemptId={attemptId}
          target={raising}
          onClose={() => setRaising(null)}
          onRaised={disputes.reload}
        />
      ) : null}
    </div>
  );
}
