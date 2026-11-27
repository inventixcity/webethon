import { cn } from "@/lib/utils";

type MeterProps = {
  value: number;
  max: number;
  /** Accessible name, for example "Answered". */
  label: string;
  /** Spoken value, for example "12 of 20 answered". */
  valueText?: string;
  /** accent: vermilion, for a failure or the bar that needs attention. info: cobalt, a live or running count. caution: amber, a count that needs review. Use rarely. */
  tone?: "ink" | "accent" | "muted" | "info" | "caution";
  size?: "sm" | "md";
  className?: string;
};

/**
 * A square progress bar. The fill is scaled, not resized, so a change animates on the compositor and lands at
 * once under reduced motion (the duration tokens become 0).
 */
export function Meter({ value, max, label, valueText, tone = "ink", size = "sm", className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(0, value), max)}
      aria-valuetext={valueText}
      className={cn("relative w-full overflow-hidden bg-paper-sunk", size === "sm" ? "h-1.5" : "h-2.5", className)}
    >
      <div
        className={cn(
          "absolute inset-0 origin-left transition-transform duration-(--duration-slow) ease-(--ease-enter)",
          tone === "accent"
            ? "bg-vermilion-deep"
            : tone === "muted"
              ? "bg-ink-muted"
              : tone === "info"
                ? "bg-cobalt"
                : tone === "caution"
                  ? "bg-amber"
                  : "bg-ink",
        )}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}
