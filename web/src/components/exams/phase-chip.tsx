import type { ExamPhase } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { PHASE_LABEL } from "./format";

/** The exam phase as a square mono chip. Ongoing is solid ink with the one vermilion mark. */
export function PhaseChip({ phase, className }: { phase: ExamPhase; className?: string }) {
  const ongoing = phase === "ongoing";
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-2 px-2.5 font-mono text-[11px] tracking-[0.12em] whitespace-nowrap uppercase",
        ongoing && "bg-ink text-paper",
        phase === "draft" && "border border-dashed border-ink-muted text-ink-soft",
        !ongoing && phase !== "draft" && "border border-ink text-ink",
        className,
      )}
    >
      {ongoing ? <span aria-hidden="true" className="size-1.5 bg-vermilion" /> : null}
      {PHASE_LABEL[phase]}
    </span>
  );
}
