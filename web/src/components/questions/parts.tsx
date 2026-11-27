import type { QuestionKind } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { KIND_LABEL } from "./model";

/** Difficulty as five small squares. The number is in the accessible name, so the squares stay decorative. */
export function DifficultySquares({ value, className }: { value: number; className?: string }) {
  return (
    <span role="img" aria-label={`Difficulty ${value} of 5`} className={cn("inline-flex items-center gap-1", className)}>
      {[1, 2, 3, 4, 5].map((step) => (
        <span
          key={step}
          aria-hidden
          className={cn("size-2 border border-ink", step <= value ? "bg-ink" : "bg-transparent")}
        />
      ))}
    </span>
  );
}

export function KindChip({ kind, className }: { kind: QuestionKind; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center border border-ink px-2 py-0.5 font-mono text-[11px] tracking-[0.12em] uppercase",
        className,
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

/** Mono uppercase caption used above fields and in metadata rows. */
export function MonoLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase", className)}>
      {children}
    </span>
  );
}

/** A native select styled like the kit inputs. */
export const selectClass =
  "h-12 w-full min-w-0 border border-ink bg-paper-raised px-3 font-sans text-base text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion disabled:opacity-50";

/** A text or number field with a square paper box. Use with native inputs. */
export const boxInputClass =
  "h-12 w-full min-w-0 border border-ink bg-paper-raised px-3 font-sans text-base text-ink outline-none placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion aria-invalid:border-vermilion-deep aria-invalid:border-2";

export const textareaClass =
  "min-h-28 w-full min-w-0 resize-y border border-ink bg-paper-raised p-3 font-sans text-base leading-relaxed text-ink outline-none placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion aria-invalid:border-vermilion-deep aria-invalid:border-2";
