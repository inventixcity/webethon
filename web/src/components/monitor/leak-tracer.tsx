"use client";

import { useId, useState } from "react";
import { api } from "@/lib/api/client";
import { FieldError } from "@/components/feedback/field-error";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/components/analytics/format";

export const TRACE_MAX = 20000;

type TraceMatch = {
  attemptId: string;
  candidate?: { displayName?: string; email?: string } | null;
};

/**
 * Leak tracer (5.1). Paste a leaked question text to see which candidate's watermark it carries.
 * A missing watermark is not evidence either way: the result only says what was found.
 */
export function LeakTracer({ examId, onOpenAttempt }: { examId: string; onOpenAttempt: (attemptId: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ match: TraceMatch | null } | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const canRun = text.trim().length > 0 && text.length <= TRACE_MAX && !busy;
  const match = result?.match ?? null;

  async function trace() {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const match = await api<TraceMatch | null>(`/exams/${examId}/trace`, { body: { text } });
      setResult({ match: match ?? null });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${fieldId}-heading`} className="grid content-start gap-5">
      <div>
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Leak tracer</p>
        <h2 id={`${fieldId}-heading`} className="mt-2 text-2xl font-semibold tracking-tight">
          Trace leaked questions
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          Each candidate receives questions with an invisible watermark. Paste text that has leaked to check whether it
          carries one.
        </p>
      </div>

      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void trace();
        }}
      >
        <label htmlFor={fieldId} className="font-mono text-[11px] tracking-[0.12em] uppercase">
          Paste leaked question text
        </label>
        <textarea
          id={fieldId}
          rows={5}
          maxLength={TRACE_MAX}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          className="w-full resize-y border border-rule bg-paper-raised p-3 font-sans text-base text-ink placeholder:text-ink-muted"
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={busy} disabled={!canRun}>
            Check text
          </Button>
        </div>
        <FieldError id={errorId} message={error} />
      </form>

      <div role="status" aria-live="polite" className="min-h-6 text-sm">
        {result?.match === null && (
          <p className="border border-rule p-4 text-ink-soft">No watermark found in this text.</p>
        )}
        {match && (
          <div className="grid gap-3 border border-ink p-4">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Watermark matched</p>
            <p className="font-sans">
              <span className="font-medium">{match.candidate?.displayName ?? "Candidate"}</span>
              {match.candidate?.email && (
                <span className="block font-mono text-[11px] text-ink-muted">{match.candidate.email}</span>
              )}
            </p>
            <p className="text-xs text-ink-muted">A match shows which copy was seen. Confirm it with other evidence.</p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => onOpenAttempt(match.attemptId)}>
                Open candidate details
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
