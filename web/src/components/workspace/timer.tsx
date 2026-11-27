"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatRemaining } from "./model";

const ANNOUNCE_MINUTES = [10, 5, 1] as const;

/**
 * Remaining time from the server clock. Under five minutes the figure turns vermilion. `hidden_until_5min`
 * hides the figure until then, but the screen reader announcements at 10, 5 and 1 minute still happen.
 */
export function Timer({
  remainingMs,
  style,
  className,
}: {
  remainingMs: number;
  style: "countdown" | "hidden_until_5min";
  className?: string;
}) {
  const under5 = remainingMs < 5 * 60 * 1000;
  const showFigure = style === "countdown" || under5;
  const expired = remainingMs <= 0;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Time left</span>
      <span
        role="timer"
        aria-label={expired ? "Time is up" : `Time left ${formatRemaining(remainingMs)}`}
        className={cn(
          "font-mono text-2xl font-medium tracking-[-0.02em] tabular-nums sm:text-3xl",
          under5 && showFigure && "text-vermilion-deep",
          !showFigure && "text-ink-soft text-base tracking-[0.12em] uppercase",
        )}
      >
        {showFigure ? formatRemaining(remainingMs) : "Hidden"}
      </span>
      <TimeAnnouncer remainingMs={remainingMs} />
    </div>
  );
}

/** Polite announcements at 10, 5 and 1 minute. Thresholds already passed on load are not announced. */
function TimeAnnouncer({ remainingMs }: { remainingMs: number }) {
  const [message, setMessage] = useState("");
  const fired = useRef<Set<number> | null>(null);

  useEffect(() => {
    const remainingMinutes = remainingMs / 60000;
    if (fired.current === null) {
      // First reading: mark thresholds already passed as done, silently.
      fired.current = new Set(ANNOUNCE_MINUTES.filter((minutes) => remainingMinutes <= minutes));
      return;
    }
    const crossed = ANNOUNCE_MINUTES.filter((minutes) => remainingMinutes <= minutes && !fired.current?.has(minutes));
    if (crossed.length === 0) return;
    for (const minutes of crossed) fired.current.add(minutes);
    // The smallest threshold crossed is the most current one.
    const smallest = Math.min(...crossed);
    setMessage(smallest === 1 ? "1 minute remaining" : `${smallest} minutes remaining`);
  }, [remainingMs]);

  return (
    <span role="status" aria-live="polite" className="sr-only">
      {message}
    </span>
  );
}
