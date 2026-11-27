import { Badge } from "@/components/ui/badge";
import type { ReviewPriority } from "@/lib/exam/types";

const LABEL: Record<ReviewPriority, string> = { none: "None", low: "Low", medium: "Medium", high: "High" };
/** none is neutral, low is informational cobalt, medium and high need a look and take amber. */
const TONE = { high: "caution", medium: "caution", low: "info", none: "muted" } as const;

/** The review priority chip. It states a priority for a person to look at, never a finding. */
export function PriorityChip({ priority, className }: { priority: ReviewPriority; className?: string }) {
  return (
    <Badge tone={TONE[priority]} size="sm" className={className} title="Indicator for review, not evidence">
      Review: {LABEL[priority]}
    </Badge>
  );
}
