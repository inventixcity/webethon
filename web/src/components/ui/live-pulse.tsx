import { cn } from "@/lib/utils";

/**
 * A cobalt dot with a ring that breathes outward, for a live or online state. The ring is transform and opacity only,
 * and it holds still under reduced motion (the global rule stops animations). Decorative: pair it with a text label.
 */
export function LivePulse({ className, tone = "info" }: { className?: string; tone?: "info" | "caution" }) {
  const fill = tone === "caution" ? "bg-amber" : "bg-cobalt";
  return (
    <span aria-hidden="true" className={cn("relative inline-flex size-2 shrink-0", className)}>
      <span className={cn("absolute inset-0 animate-breathe", fill)} />
      <span className={cn("relative size-2", fill)} />
    </span>
  );
}
