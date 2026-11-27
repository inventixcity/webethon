"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type HoldButtonProps = {
  label?: string;
  doneLabel?: string;
  /** Milliseconds the button must be held. */
  duration?: number;
  onConfirm?: () => void;
  className?: string;
};

/** A press-and-hold button for actions that shouldn't happen by accident. A line traces its edge as you hold. */
export function HoldButton({
  label = "Hold to confirm",
  doneLabel = "Confirmed",
  duration = 1400,
  onConfirm,
  className,
}: HoldButtonProps) {
  const [phase, setPhase] = useState<"idle" | "holding" | "done">("idle");
  const trace = useRef<SVGRectElement>(null);
  const raf = useRef(0);
  const progress = useRef(0);
  const holding = useRef(false);

  const paint = () => trace.current?.setAttribute("stroke-dashoffset", String(1 - progress.current));

  function run(direction: 1 | -1) {
    cancelAnimationFrame(raf.current);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.max(0, now - last);
      last = now;
      // Letting go drains it three times faster than it filled.
      const rate = direction > 0 ? 1 : 3;
      progress.current = Math.min(1, Math.max(0, progress.current + (direction * rate * dt) / duration));
      paint();
      if (direction > 0 && progress.current >= 1) {
        holding.current = false;
        setPhase("done");
        onConfirm?.();
        return;
      }
      if (direction < 0 && progress.current <= 0) {
        setPhase("idle");
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }

  function start() {
    if (phase === "done" || holding.current) return;
    holding.current = true;
    setPhase("holding");
    run(1);
  }

  function stop() {
    if (!holding.current) return;
    holding.current = false;
    run(-1);
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") stop();
      }}
      onBlur={stop}
      aria-label={phase === "done" ? doneLabel : `${label}: press and hold`}
      className={cn(
        "relative h-16 min-w-72 cursor-pointer touch-none px-8 font-mono text-xs tracking-[0.14em] uppercase transition-colors duration-300 select-none",
        phase === "done" ? "bg-ink text-paper" : "bg-paper-raised text-ink",
        className,
      )}
    >
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
        <rect x="0.5" y="0.5" width="100%" height="100%" fill="none" stroke="var(--rule)" />
        <rect
          ref={trace}
          x="1.5"
          y="1.5"
          style={{ width: "calc(100% - 3px)", height: "calc(100% - 3px)" }}
          fill="none"
          stroke="var(--vermilion)"
          strokeWidth="3"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset="1"
        />
      </svg>
      {phase === "done" ? doneLabel : phase === "holding" ? "Keep holding" : label}
    </button>
  );
}
