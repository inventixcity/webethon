import { CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import type { JobStatus } from "@/features/jobs/client";
import { cn } from "@/lib/utils";

/*
 * Each status has a text label and its own shape, so it never relies on colour alone.
 * The shape is decorative (aria-hidden); the text is what a screen reader reads.
 */
const STATUS: Record<JobStatus | "unknown", { text: string; Icon: typeof CircleDashed }> = {
  queued: { text: "Queued", Icon: CircleDashed },
  running: { text: "Running", Icon: LoaderCircle },
  done: { text: "Done", Icon: CircleCheck },
  failed: { text: "Failed", Icon: TriangleAlert },
  dead: { text: "Dead", Icon: CircleX },
  unknown: { text: "Unknown", Icon: CircleDashed },
};

export function JobStatusLabel({ status, className }: { status: JobStatus | "unknown"; className?: string }) {
  const { text, Icon } = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", status === "running" && "motion-safe:animate-spin")} />
      {text}
    </span>
  );
}
