"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/api/client";
import type { GradingItem } from "@/lib/exam/types";
import { FieldError } from "@/components/feedback/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { conflictReason, formatMarks, messageOf } from "@/components/analytics/format";
import { checkMarks, FEEDBACK_MAX, halfMarks, MARKS_STEP } from "./marks";

/**
 * One written answer, graded blind: the script label is all the examiner sees about the candidate.
 * The answer is plain text. It is never rendered as HTML.
 * Ctrl+Enter (or Cmd+Enter) saves and reports `next`, so the parent can move focus to the next script.
 */
export function GradeCard({
  item,
  onSaved,
}: {
  item: GradingItem;
  onSaved: (saved: GradingItem, next: boolean) => void;
}) {
  const ids = useId();
  const [marks, setMarks] = useState(item.manualMarks === null ? "" : String(item.manualMarks));
  const [feedback, setFeedback] = useState(item.feedback ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = `${ids}-error`;

  async function save(next: boolean) {
    if (busy) return;
    const check = checkMarks(marks, item.marks);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    if (feedback.length > FEEDBACK_MAX) {
      setError(`Feedback is limited to ${FEEDBACK_MAX} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api<GradingItem>(`/attempts/${item.attemptId}/answers/${item.itemId}/grade`, {
        method: "PUT",
        body: { marks: check.value, feedback },
      });
      onSaved(saved, next);
    } catch (cause) {
      setError(conflictReason(cause) === "published" ? "Unpublish results to change grades." : messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void save(true);
    }
  }

  const max = item.marks;
  const quick = [
    { label: "0", value: 0 },
    { label: "Half", value: halfMarks(max) },
    { label: "Full", value: max },
  ];

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      data-grade-card
      onKeyDown={onKeyDown}
      className="grid gap-6 border border-rule bg-paper-raised p-5 md:p-6"
    >
      <header className="grid gap-2">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          Question {item.position} · {max} {max === 1 ? "mark" : "marks"}
        </p>
        <h3 id={`${ids}-heading`} className="text-xl font-semibold tracking-tight">
          {item.scriptLabel}
        </h3>
        <p className="font-sans text-base leading-relaxed whitespace-pre-wrap break-words">{item.stem}</p>
      </header>

      <details className="group border-t border-rule pt-4">
        <summary className="cursor-pointer font-mono text-[11px] tracking-[0.12em] uppercase underline-offset-4 hover:underline">
          Rubric
        </summary>
        <p className="mt-3 text-sm whitespace-pre-wrap break-words text-ink-soft">{item.rubric || "No rubric was written."}</p>
      </details>

      <div className="grid gap-2">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          Answer · {item.wordCount} {item.wordCount === 1 ? "word" : "words"}
        </p>
        <div
          aria-label={`Answer for ${item.scriptLabel}`}
          tabIndex={0}
          className="border-l-2 border-ink bg-paper p-4 font-sans text-base leading-relaxed break-words whitespace-pre-wrap"
        >
          {item.answerText.trim() === "" ? <span className="text-ink-muted">No answer was given.</span> : item.answerText}
        </div>
      </div>

      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
        noValidate
      >
        <div className="grid gap-3">
          <Label htmlFor={`${ids}-marks`}>
            Marks (0 to {formatMarks(max)}, steps of {MARKS_STEP})
          </Label>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Input
                id={`${ids}-marks`}
                data-grade-marks
                type="number"
                inputMode="decimal"
                min={0}
                max={max}
                step={MARKS_STEP}
                value={marks}
                onChange={(event) => setMarks(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="font-mono text-lg tabular-nums"
              />
            </div>
            <div role="group" aria-label="Quick marks" className="flex flex-wrap gap-2">
              {quick.map((option) => (
                <Button
                  key={option.label}
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Set ${formatMarks(option.value)} marks`}
                  onClick={() => {
                    setMarks(String(option.value));
                    setError(null);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <FieldError id={errorId} message={error} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={`${ids}-feedback`}>Feedback for the candidate</Label>
          <textarea
            id={`${ids}-feedback`}
            rows={3}
            maxLength={FEEDBACK_MAX}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            className="w-full resize-y border border-rule bg-paper p-3 font-sans text-sm text-ink"
          />
          <p className="font-mono text-[11px] text-ink-muted">
            {feedback.length} / {FEEDBACK_MAX}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={busy} size="md">
            Save
          </Button>
          <Button type="button" variant="secondary" size="md" loading={busy} onClick={() => void save(true)}>
            Save and next
          </Button>
          <p className="font-mono text-[11px] text-ink-muted">Ctrl+Enter saves and moves on</p>
        </div>
      </form>
    </section>
  );
}
