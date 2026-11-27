import { Badge } from "@/components/ui/badge";
import type { ExamPhase } from "@/lib/exam/types";
import { PHASE_LABEL } from "./format";

const TONE = {
  draft: "dashed",
  scheduled: "outline",
  ongoing: "solid",
  closed: "outline",
  completed: "muted",
  archived: "muted",
} as const;

/** The exam phase as a square mono chip. Ongoing is solid ink with a live vermilion mark. */
export function PhaseChip({ phase, className }: { phase: ExamPhase; className?: string }) {
  return (
    <Badge tone={TONE[phase]} dot={phase === "ongoing" ? "live" : phase === "scheduled" || phase === "closed"} srLabel="Phase" className={className}>
      {PHASE_LABEL[phase]}
    </Badge>
  );
}
