"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { GradingItem } from "@/lib/exam/types";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Meter } from "@/components/ui/meter";
import { SectionIntro } from "@/components/exams/section-intro";
import { formatPercent, messageOf } from "@/components/analytics/format";
import { GradeCard } from "./grade-card";

type Mode = "pending" | "all";

const key = (item: GradingItem) => `${item.attemptId}:${item.itemId}`;

/**
 * Blind grading, one script at a time. Written answers from finalized attempts, grouped by question. Candidate
 * identity is never loaded here: each script is shown by its label only.
 */
export function GradingView({ examId }: { examId: string }) {
  const [all, setAll] = useState<GradingItem[] | null>(null);
  const [pending, setPending] = useState<GradingItem[] | null>(null);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [mode, setMode] = useState<Mode>("pending");
  const [questionFilter, setQuestionFilter] = useState("all");
  const [version, setVersion] = useState(0);
  const [index, setIndex] = useState(0);
  const questionId = useId();

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([
      api<GradingItem[]>(`/exams/${examId}/grading`),
      api<GradingItem[]>(`/exams/${examId}/grading?pending=true`),
    ])
      .then(([everything, queue]) => {
        if (!live) return;
        setAll(everything);
        setPending(queue);
      })
      .catch((cause: unknown) => {
        if (live) setError({ message: messageOf(cause), requestId: cause instanceof ApiError ? cause.requestId : undefined });
      });
    return () => {
      live = false;
    };
  }, [examId, version]);

  const questions = useMemo(() => {
    const seen = new Map<string, { itemId: string; position: number; stem: string; marks: number }>();
    for (const item of all ?? []) {
      if (!seen.has(item.itemId)) {
        seen.set(item.itemId, { itemId: item.itemId, position: item.position, stem: item.stem, marks: item.marks });
      }
    }
    return [...seen.values()].sort((a, b) => a.position - b.position);
  }, [all]);

  const source = mode === "pending" ? pending : all;
  const visible = (source ?? []).filter((item) => questionFilter === "all" || item.itemId === questionFilter);
  const total = all?.length ?? 0;
  const graded = all?.filter((item) => item.gradedAt !== null).length ?? 0;
  const current = visible.length > 0 ? Math.min(index, visible.length - 1) : 0;
  const item = visible[current];

  // Saving moves the examiner on. In the pending queue the saved script leaves the list, so the same index is the next
  // one; in the full list the index advances.
  function applySaved(saved: GradingItem, next: boolean) {
    setAll((list) => list?.map((entry) => (key(entry) === key(saved) ? saved : entry)) ?? list);
    setPending((list) =>
      list
        ? saved.gradedAt
          ? list.filter((entry) => key(entry) !== key(saved))
          : list.map((entry) => (key(entry) === key(saved) ? saved : entry))
        : list,
    );
    if (next) setIndex((value) => (mode === "all" ? value + 1 : value));
  }

  if (all === null && pending === null && error === null) {
    return <BrailleSpinner label="Loading grading queue" className="m-8 text-ink" />;
  }

  return (
    <div className="grid gap-10 px-4 py-8 md:px-8">
      <SectionIntro
        eyebrow="Grading / 03"
        title="Written answers"
        summary="Scripts are blind-graded. Each one is shown by its label, not by the candidate's name. Grades can be changed until results are published."
      >
        {all && (
          <div className="grid max-w-xl gap-3 border-l-4 border-amber bg-paper-raised p-4">
            <div className="flex items-baseline justify-between gap-4 font-mono text-sm" aria-live="polite">
              <span>
                {graded} of {total} graded
              </span>
              <span className="text-ink-muted tabular-nums">{formatPercent(total > 0 ? (graded / total) * 100 : 0)}</span>
            </div>
            <Meter value={graded} max={Math.max(1, total)} tone="info" size="md" label={`${graded} of ${total} graded`} valueText={`${graded} of ${total} graded`} />
          </div>
        )}
      </SectionIntro>

      {error && (
        <div className="grid gap-3 border-l-4 border-vermilion-deep bg-paper-raised p-5">
          <p className="text-sm text-vermilion-deep">{error.message}</p>
          {error.requestId && <p className="font-mono text-[11px] text-ink-muted">Request ID: {error.requestId}</p>}
          <div>
            <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {all && (
        <div className="flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
          <div role="group" aria-label="Show" className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={mode === "pending"}
              onClick={() => {
                setMode("pending");
                setIndex(0);
              }}
            >
              Pending ({pending?.length ?? 0})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={mode === "all"}
              onClick={() => {
                setMode("all");
                setIndex(0);
              }}
            >
              All ({total})
            </Button>
          </div>
          <div className="grid gap-2">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Filter by question</p>
            <div id={questionId} role="group" aria-label="Filter by question" className="flex max-w-3xl flex-wrap gap-2">
              <Button variant="secondary" size="sm" className="aria-pressed:bg-fill aria-pressed:text-on-fill" aria-pressed={questionFilter === "all"} onClick={() => { setQuestionFilter("all"); setIndex(0); }}>All questions</Button>
              {questions.map((question) => (
                <Button key={question.itemId} variant="secondary" size="sm" className="aria-pressed:bg-fill aria-pressed:text-on-fill" aria-pressed={questionFilter === question.itemId} onClick={() => { setQuestionFilter(question.itemId); setIndex(0); }}>
                  Q{question.position} · {question.marks} marks
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {all && visible.length === 0 && (
        <EmptyState
          art="empty-results"
          eyebrow={total === 0 ? "Queue empty / 00" : "Queue clear / 00"}
          title={
            total === 0
              ? "No written answers from finalized attempts yet."
              : mode === "pending"
                ? "Every written answer in this view is graded."
                : "No written answers match this question."
          }
        />
      )}

      {item && (
        <div className="grid gap-6">
          <nav aria-label="Script navigation" className="flex flex-wrap items-center justify-between gap-4">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums" aria-live="polite">
              Script {current + 1} of {visible.length}
              {mode === "pending" ? " in the queue" : ""}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={current === 0} onClick={() => setIndex(Math.max(0, current - 1))}>
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={current >= visible.length - 1}
                onClick={() => setIndex(Math.min(visible.length - 1, current + 1))}
              >
                Next
              </Button>
            </div>
          </nav>
          <GradeCard key={key(item)} item={item} onSaved={applySaved} />
        </div>
      )}
    </div>
  );
}
