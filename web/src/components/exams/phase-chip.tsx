import { Badge } from "@/components/ui/badge";
import type { ExamPhase } from "@/lib/exam/types";
import { PHASE_LABEL } from "./format";

/** ongoing is live cobalt, scheduled is informational, closed and completed are neutral, draft is not yet real. */
const TONE = {
  draft: "dashed",
  scheduled: "info",
  ongoing: "live",
  closed: "muted",
  completed: "muted",
  archived: "muted",
} as const;

/** The exam phase as a square mono chip. Ongoing breathes in cobalt so a running exam reads at a glance. */
export function PhaseChip({ phase, className }: { phase: ExamPhase; className?: string }) {
  return (
    <Badge tone={TONE[phase]} dot={phase === "ongoing" ? "live" : phase === "scheduled"} srLabel="Phase" className={className}>
      {PHASE_LABEL[phase]}
    </Badge>
  );
}
