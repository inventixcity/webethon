import { cn } from "@/lib/utils";

type TickerProps = {
  items: readonly string[];
  /** Seconds for one full cycle. */
  duration?: number;
  /** Runs upward along a vertical rail instead of across. */
  vertical?: boolean;
  reverse?: boolean;
  className?: string;
};

// One run must be wider than the widest screen, so the items repeat inside it.
const REPEATS = 6;

/** An endless marquee. The text is repeated visually, and screen readers skip it. */
export function Ticker({ items, duration = 48, vertical = false, reverse = false, className }: TickerProps) {
  const run = Array.from({ length: REPEATS }, () => items).flat();

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex overflow-hidden font-mono text-[11px] tracking-[0.14em] whitespace-nowrap uppercase",
        vertical && "h-full [writing-mode:vertical-rl]",
        className,
      )}
    >
      <div
        // In vertical writing mode a flex row already runs top to bottom.
        className={cn("flex", vertical ? "h-max animate-ticker-y motion-reduce:animate-none" : "w-max animate-ticker motion-reduce:animate-none")}
        style={{ animationDuration: `${duration}s`, animationDirection: reverse ? "reverse" : undefined }}
      >
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center">
            {run.map((item, index) => (
              <span
                // The list is static and repeats by design, so position is its identity.
                key={`${copy}-${index}`}
                className={cn("flex items-center gap-6", !vertical && "px-3")}
              >
                {item}
                <span className={cn("size-1.5 bg-vermilion", vertical && "mb-6")} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
