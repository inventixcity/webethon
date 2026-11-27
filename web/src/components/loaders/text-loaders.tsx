"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const BRAILLE = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const GLYPHS = "#%&*+=<>/\\|~^:;";

/** Repeats a callback until unmounted, unless the visitor prefers reduced motion. */
function useTicker(ms: number, tick: () => void) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(tick, ms);
    return () => window.clearInterval(id);
  }, [ms, tick]);
}

/** A terminal spinner with a label. */
export function BrailleSpinner({ label = "Loading", className }: { label?: string; className?: string }) {
  const [frame, setFrame] = useState(0);
  useTicker(80, () => setFrame((value) => (value + 1) % BRAILLE.length));

  return (
    <span role="status" className={cn("inline-flex items-center gap-2 font-mono text-sm", className)}>
      <span aria-hidden="true" className="text-vermilion">
        {BRAILLE[frame]}
      </span>
      {label}
    </span>
  );
}

/**
 * A text progress bar. Pass `value` for real progress from 0 to 100. Without it, the block
 * shuttles back and forth to show work of unknown length.
 */
export function AsciiBar({ value, width = 24, className }: { value?: number; width?: number; className?: string }) {
  const [frame, setFrame] = useState(0);
  useTicker(70, () => setFrame((current) => current + 1));

  let bar: string;
  if (value === undefined) {
    const span = width - 4;
    const position = Math.abs(((frame % (span * 2)) + span * 2) % (span * 2) - span);
    bar = `${"░".repeat(position)}████${"░".repeat(width - 4 - position)}`;
  } else {
    const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width);
    bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  }

  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      className={cn("inline-block font-mono text-sm whitespace-pre", className)}
    >
      [{bar}]{value === undefined ? "" : ` ${String(Math.round(value)).padStart(3, " ")}%`}
    </span>
  );
}

/** A word that keeps scrambling and resolving. */
export function ScrambleLabel({ text = "LOADING", className }: { text?: string; className?: string }) {
  const [frame, setFrame] = useState(0);
  useTicker(60, () => setFrame((value) => value + 1));

  const cycle = text.length * 3 + 20;
  const settled = Math.min(text.length, Math.floor((frame % cycle) / 3));
  const shown = [...text]
    .map((char, index) => (index < settled ? char : (GLYPHS[(frame * 7 + index * 13) % GLYPHS.length] ?? char)))
    .join("");

  return (
    <span role="status" aria-label={text} className={cn("inline-block font-mono tracking-[0.14em]", className)}>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

/** A large percentage for a full-page wait. Pass `value` for real progress. */
export function PercentCounter({ value, className }: { value: number; className?: string }) {
  const rounded = Math.round(Math.min(100, Math.max(0, value)));

  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rounded}
      className={cn("inline-flex items-start font-semibold leading-none tracking-[-0.03em] tabular-nums", className)}
    >
      {String(rounded).padStart(3, "0")}
      <span className="mt-[0.12em] font-mono text-[0.25em] font-normal tracking-normal text-vermilion-deep">%</span>
    </span>
  );
}
