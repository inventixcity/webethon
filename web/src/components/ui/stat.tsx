"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { duration } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Eases a number toward its new value, so a changing count reads as a change. Lands at once under reduced motion. */
function useTweened(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    if (reduced || start === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    const length = duration.slow * 2.5;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / length);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = start + (value - start) * eased;
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return shown;
}

type StatProps = {
  label: string;
  /** A number tweens when it changes. A string is shown as it is. */
  value: number | string;
  /** Formats a numeric value. Defaults to a whole number. */
  format?: (value: number) => string;
  note?: ReactNode;
  /** Draws the one vermilion mark beside the label, for the number that matters most on this view. */
  focal?: boolean;
  className?: string;
};

/** One KPI: a mono label over a large tabular number. Use inside StatGrid (a dl). */
export function Stat({ label, value, format, note, focal = false, className }: StatProps) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const target = numeric ? (value as number) : 0;
  const tweened = useTweened(target);
  const render = (n: number) => (format ? format(n) : String(Math.round(n)));
  const text = numeric ? render(tweened) : String(value);
  const finalText = numeric ? render(target) : String(value);

  return (
    <div className={cn("grid content-start gap-2 border-t border-rule py-5 pr-4", className)}>
      <dt className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        {focal ? <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" /> : null}
        {label}
      </dt>
      <dd className="text-[clamp(1.75rem,3.2vw,2.5rem)] leading-none font-medium tracking-[-0.03em] tabular-nums">
        <span aria-hidden="true">{text}</span>
        <span className="sr-only">{finalText}</span>
      </dd>
      {note ? <dd className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{note}</dd> : null}
    </div>
  );
}

const COLUMNS = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-3 lg:grid-cols-6",
} as const;

/** A row of Stats. Two columns on phones, `columns` from md up. */
export function StatGrid({
  children,
  columns = 4,
  className,
}: {
  children: ReactNode;
  columns?: keyof typeof COLUMNS;
  className?: string;
}) {
  return <dl className={cn("grid grid-cols-2 gap-x-6", COLUMNS[columns], className)}>{children}</dl>;
}
