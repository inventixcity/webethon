"use client";

import { useId } from "react";
import type { GradingSuggestion } from "@/lib/exam/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMarks } from "@/components/analytics/format";

/**
 * What the assistant suggested for this answer. "Use this mark" copies the number into the marks field and
 * does nothing else: the examiner still saves. Nothing here is applied automatically.
 */
export function SuggestionCard({
  suggestion,
  onUse,
  onDismiss,
}: {
  suggestion: GradingSuggestion;
  onUse: () => void;
  onDismiss: () => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-4 border-l-4 border-cobalt bg-paper-raised p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 id={headingId} className="font-mono text-[11px] tracking-[0.14em] text-cobalt-deep uppercase">
          AI suggestion
        </h4>
        <p className="font-mono text-sm tabular-nums">
          <span className="font-medium">{formatMarks(suggestion.suggestedMarks)}</span>
          <span className="text-ink-muted"> / {formatMarks(suggestion.maxMarks)} marks</span>
        </p>
      </div>

      {suggestion.rationale.trim() !== "" && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-ink-soft">{suggestion.rationale}</p>
      )}

      {suggestion.rubricHits.length > 0 && (
        <div className="grid gap-2">
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Rubric points matched</p>
          <ul className="flex list-none flex-wrap gap-2 p-0" aria-label="Rubric points matched">
            {suggestion.rubricHits.map((hit, index) => (
              <li key={`${index}-${hit}`}>
                <Badge tone="chip" size="sm" className="h-auto max-w-full py-1 normal-case tracking-normal">
                  {hit}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="font-mono text-[11px] leading-relaxed text-ink-soft">
        AI suggestion: advisory only, you decide. Model: {suggestion.model}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onUse}>
          Use this mark
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
