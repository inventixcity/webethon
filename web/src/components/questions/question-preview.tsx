import { cn } from "@/lib/utils";
import { KIND_LABEL, formatMarks, scoringSummary, type DraftState } from "./model";
import { MonoLabel } from "./parts";

/**
 * What a candidate would see for this draft, updated on every keystroke. Labelled as a preview, and it
 * shows the answer key below it because the examiner is the only reader of this screen.
 */
export function QuestionPreview({ draft }: { draft: DraftState }) {
  const written = draft.kind === "written";
  const marks = Number(draft.marks);
  const negative = Number(draft.negativeMarks);
  const keyLetters = draft.correct.map((id) => id.toUpperCase());
  const maxWords = draft.maxWords.trim() === "" ? null : Number(draft.maxWords);

  return (
    <section
      aria-labelledby="preview-heading"
      className="grid gap-6 border border-ink bg-paper-raised p-5 md:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="preview-heading" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Candidate view / preview
        </h2>
        <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          {KIND_LABEL[draft.kind]} · {Number.isFinite(marks) ? formatMarks(marks) : "–"} marks
        </span>
      </div>

      <p className="font-sans text-lg leading-relaxed whitespace-pre-line text-ink">
        {draft.stem.trim() || <span className="text-ink-muted">The question text appears here.</span>}
      </p>

      {written ? (
        <div className="grid gap-2">
          <div aria-hidden className="h-28 border border-ink bg-paper p-3 font-sans text-sm text-ink-muted">
            Answer area
          </div>
          <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
            {maxWords ? `Word limit: ${maxWords}` : "No word limit"}
          </p>
        </div>
      ) : (
        <ul className="grid gap-2" aria-label="Options">
          {draft.options.map((option) => {
            const isKey = draft.correct.includes(option.id);
            return (
              <li
                key={option.id}
                className="flex items-start gap-3 border border-rule bg-paper p-3 font-sans text-base text-ink"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-4 shrink-0 border border-ink",
                    draft.kind === "multi" ? "" : "rounded-full",
                  )}
                />
                <span className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
                  {option.id.toUpperCase()}
                </span>
                <span className="min-w-0 break-words">{option.text.trim() || "Option text"}</span>
                {isKey && <span className="sr-only">(correct answer)</span>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-2 border-t border-rule pt-4">
        <p className="font-sans text-sm text-ink-soft">{scoringSummary(draft)}</p>
        {!written && Number.isFinite(negative) && negative > 0 && (
          <p className="font-sans text-sm text-ink-soft">Wrong answer: −{formatMarks(negative)} marks.</p>
        )}
      </div>

      {!written && (
        <p className="font-mono text-[11px] tracking-[0.08em] uppercase">
          <MonoLabel className="mr-2">Answer key</MonoLabel>
          <span className="text-ink">{keyLetters.length > 0 ? keyLetters.join(", ") : "Not set"}</span>
        </p>
      )}
    </section>
  );
}
