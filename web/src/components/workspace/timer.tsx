"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatRemaining, speakRemaining } from "./model";

const FIVE_MIN = 5 * 60 * 1000;
const MILESTONES = [30, 15, 10, 5, 1] as const;

/**
 * Remaining time. `remainingMs` comes from useAttempt, which ticks it from the server clock offset
 * (`serverNowMs()`), never from `Date.now()`; this component only displays it.
 *
 * Under five minutes the figure turns vermilion: one of the two places the accent appears in the workspace.
 * `hidden_until_5min` hides the figure until then, but the spoken milestones still happen.
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
  const expired = remainingMs <= 0;
  const under5 = remainingMs < FIVE_MIN && !expired;
  const showFigure = style === "countdown" || remainingMs < FIVE_MIN;

  return (
    <div className={cn("flex items-baseline gap-3", className)}>
      <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase" aria-hidden="true">
        {expired ? "Time" : "Time left"}
      </span>
      <span
        role="timer"
        aria-label={expired ? "Time is up" : showFigure ? `Time left: ${speakRemaining(remainingMs)}` : "Timer hidden until 5 minutes remain"}
        className={cn(
          "font-mono font-medium tabular-nums",
          showFigure ? "text-2xl tracking-[-0.02em] sm:text-[1.75rem]" : "text-[11px] tracking-[0.14em] text-ink-soft uppercase",
          under5 && "text-vermilion-deep",
        )}
      >
        {expired ? "00:00" : showFigure ? formatRemaining(remainingMs) : "Hidden until 5 min"}
      </span>
      <TimeAnnouncer remainingMs={remainingMs} />
    </div>
  );
}

/**
 * Spoken milestones at 30, 15, 10 and 5 minutes (polite) and at 1 minute and time-up (assertive).
 * Milestones already passed when the page loads are skipped, so a refresh never replays them.
 */
function TimeAnnouncer({ remainingMs }: { remainingMs: number }) {
  const [polite, setPolite] = useState("");
  const [urgent, setUrgent] = useState("");
  const fired = useRef<Set<number> | null>(null);

  useEffect(() => {
    const minutesLeft = remainingMs / 60000;
    if (fired.current === null) {
      // The first real reading marks thresholds already passed as done, silently.
      if (remainingMs <= 0) return;
      fired.current = new Set(MILESTONES.filter((minutes) => minutesLeft <= minutes));
      return;
    }
    if (remainingMs <= 0) {
      if (!fired.current.has(0)) {
        fired.current.add(0);
        setUrgent("Time is up. Your answers are being submitted.");
      }
      return;
    }
    const crossed = MILESTONES.filter((minutes) => minutesLeft <= minutes && !fired.current?.has(minutes));
    if (crossed.length === 0) return;
    for (const minutes of crossed) fired.current.add(minutes);
    const smallest = Math.min(...crossed);
    if (smallest === 1) setUrgent("1 minute remaining. Your answers are saved as you go.");
    else setPolite(`${smallest} minutes remaining.`);
  }, [remainingMs]);

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {polite}
      </span>
      <span aria-live="assertive" className="sr-only">
        {urgent}
      </span>
    </>
  );
}

/**
 * A hairline across the top bar that fills as time is used. It is the one continuous motion in the workspace
 * and moves only with the server clock. Transform only; with reduced motion it still updates, without easing.
 */
export function TimeRule({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const used = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 0;
  const under5 = remainingMs < FIVE_MIN && remainingMs > 0;
  return (
    <div aria-hidden="true" className="relative h-0.5 w-full overflow-hidden bg-(--ws-line)">
      <div
        className={cn(
          "absolute inset-y-0 left-0 w-full origin-left transition-transform duration-1000 ease-linear motion-reduce:transition-none",
          under5 ? "bg-vermilion" : "bg-ink",
        )}
        style={{ transform: `scaleX(${used})` }}
      />
    </div>
  );
}
