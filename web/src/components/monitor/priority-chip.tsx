import type { ReviewPriority } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

const LABEL: Record<ReviewPriority, string> = { none: "None", low: "Low", medium: "Medium", high: "High" };

/** The review priority chip. It states a priority for a human to look at, never a finding. */
export function PriorityChip({ priority, className }: { priority: ReviewPriority; className?: string }) {
  return (
    <span
      data-priority={priority}
      className={cn(
        "inline-flex items-center border px-2 py-0.5 font-mono text-[11px] tracking-[0.12em] whitespace-nowrap uppercase",
        priority === "high" && "border-vermilion-deep bg-vermilion-deep text-paper",
        priority === "medium" && "border-ink text-ink",
        (priority === "low" || priority === "none") && "border-rule text-ink-soft",
        className,
      )}
    >
      Review: {LABEL[priority]}
    </span>
  );
}
