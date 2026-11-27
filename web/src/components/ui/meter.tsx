import { cn } from "@/lib/utils";

type MeterProps = {
  value: number;
  max: number;
  /** Accessible name, for example "Answered". */
  label: string;
  /** Spoken value, for example "12 of 20 answered". */
  valueText?: string;
  /** info: cobalt, a live or running count (the default). accent: vermilion, for a failure or the bar that needs attention. caution: amber, a count that needs review. ink: graphite. muted: grey. */
  tone?: "ink" | "accent" | "muted" | "info" | "caution";
  size?: "sm" | "md";
  className?: string;
};

const FILL: Record<NonNullable<MeterProps["tone"]>, string> = {
  ink: "bg-fill",
  accent: "bg-vermilion-deep",
  muted: "bg-ink-muted",
  info: "bg-cobalt",
  caution: "bg-amber",
};

/**
 * A square progress bar. The fill is scaled, not resized, so a change animates on the compositor and lands at
 * once under reduced motion (the duration tokens become 0). A light sheen crosses a filled bar, so it reads as live.
 * The sheen is transform only, and reduced motion holds it still.
 */
export function Meter({ value, max, label, valueText, tone = "info", size = "sm", className }: MeterProps) {
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
        className={cn("absolute inset-0 origin-left transition-transform duration-(--duration-slow) ease-(--ease-enter)", FILL[tone])}
        style={{ transform: `scaleX(${ratio})` }}
      >
        {ratio > 0 ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-gradient-to-r from-transparent via-paper/45 to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}
