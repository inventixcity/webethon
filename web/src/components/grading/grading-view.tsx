"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { GradingItem } from "@/lib/exam/types";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { formatPercent, messageOf } from "@/components/analytics/format";
import { GradeCard } from "./grade-card";

type Mode = "pending" | "all";

const key = (item: GradingItem) => `${item.attemptId}:${item.itemId}`;

/**
 * Blind grading queue. Written answers from finalized attempts, grouped by question. Candidate identity is never
 * loaded here: each script is shown by its label only.
 */
export function GradingView({ examId }: { examId: string }) {
  const [all, setAll] = useState<GradingItem[] | null>(null);
  const [pending, setPending] = useState<GradingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pending");
  const [questionFilter, setQuestionFilter] = useState("all");
  const [version, setVersion] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
        if (live) setError(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [examId, version]);

  // After "Save and next", focus the script that moved into the same place in the queue.
  useEffect(() => {
    if (focusIndex === null) return;
    const fields = listRef.current?.querySelectorAll<HTMLInputElement>("[data-grade-marks]");
    const target = fields && fields.length > 0 ? fields[Math.min(focusIndex, fields.length - 1)] : undefined;
    target?.focus();
    setFocusIndex(null);
  }, [focusIndex, pending, questionFilter, mode]);

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
  const ratio = total > 0 ? graded / total : 0;

  function applySaved(saved: GradingItem, next: boolean, index: number) {
    setAll((current) => current?.map((item) => (key(item) === key(saved) ? saved : item)) ?? current);
    setPending((current) =>
      current
        ? saved.gradedAt
          ? current.filter((item) => key(item) !== key(saved))
          : current.map((item) => (key(item) === key(saved) ? saved : item))
        : current,
    );
    if (next) setFocusIndex(index);
  }

  if (all === null && pending === null && error === null) {
    return <BrailleSpinner label="Loading grading queue" className="m-8 text-ink" />;
  }

  return (
    <div className="grid gap-10 px-4 py-8 md:px-8">
      <header className="grid gap-5">
        <div>
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Grading</p>
          <h2 className="mt-2 text-3xl leading-none font-semibold tracking-tight md:text-4xl">Written answers</h2>
          <p className="mt-3 max-w-prose text-sm text-ink-soft">
            Scripts are blind-graded. Each one is shown by its label, not by the candidate&apos;s name. Grades can be
            changed until results are published.
          </p>
        </div>
        {all && (
          <div className="grid gap-2">
            <p className="font-mono text-xs" aria-live="polite">
              {graded} of {total} graded ({formatPercent(ratio * 100)})
            </p>
            <div role="progressbar" aria-label={`${graded} of ${total} graded`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={graded} className="h-2 max-w-xl bg-paper-sunk">
              <div className="h-full bg-ink" style={{ width: `${ratio * 100}%` }} />
            </div>
          </div>
        )}
      </header>

      {error && (
        <div className="grid gap-3 border border-vermilion-deep p-5">
          <p className="text-sm text-vermilion-deep">{error}</p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {all && (
        <div className="flex flex-wrap items-end gap-6">
          <div role="group" aria-label="Show" className="flex gap-2">
            <Button variant="secondary" size="sm" aria-pressed={mode === "pending"} onClick={() => setMode("pending")}>
              Pending ({pending?.length ?? 0})
            </Button>
            <Button variant="secondary" size="sm" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
              All ({total})
            </Button>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={questionId}>Question</Label>
            <select
              id={questionId}
              value={questionFilter}
              onChange={(event) => setQuestionFilter(event.target.value)}
              className="h-12 w-full max-w-md border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
            >
              <option value="all">All questions</option>
              {questions.map((question) => (
                <option key={question.itemId} value={question.itemId}>
                  Q{question.position} ({question.marks} marks): {question.stem.slice(0, 60)}
                  {question.stem.length > 60 ? "…" : ""}
                </option>
              ))}
            </select>
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

      {visible.length > 0 && (
        <div ref={listRef} className="grid gap-6" aria-live="off">
          {visible.map((item, index) => (
            <GradeCard key={key(item)} item={item} onSaved={(saved, next) => applySaved(saved, next, index)} />
          ))}
        </div>
      )}
    </div>
  );
}
