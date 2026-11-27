"use client";

import { useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useFrame } from "../use-frame";

const WORDS_PER_MINUTE = 220;
const READING_LINE = 0.62; // where the pen sits, as a share of the viewport's height

/** A phrase the marker pen draws over as it reaches the reading line. Wraps across lines cleanly. */
export function Mark({ children }: { children: React.ReactNode }) {
  return (
    <mark
      data-mark
      className="bg-transparent bg-no-repeat text-inherit"
      style={{
        backgroundImage: "linear-gradient(color-mix(in oklab, var(--vermilion) 34%, transparent) 0 0)",
        backgroundPosition: "0 88%",
        backgroundSize: "var(--drawn, 0%) 72%",
      }}
    >
      {children}
    </mark>
  );
}

export type ReadingMarkerProps = {
  children: React.ReactNode;
  className?: string;
};

/** A long-read wrapper. A pen highlights key phrases as you scroll, and a rail counts down the minutes left. */
export function ReadingMarker({ children, className }: ReadingMarkerProps) {
  const reduced = useReducedMotion() ?? false;
  const host = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);

  useFrame(host, () => {
    const element = body.current;
    if (!element) return;
    const line = window.innerHeight * READING_LINE;
    const box = element.getBoundingClientRect();
    const read = Math.min(1, Math.max(0, (line - box.top) / box.height));
    host.current?.style.setProperty("--read", read.toFixed(4));

    for (const mark of element.querySelectorAll<HTMLElement>("[data-mark]")) {
      const rect = mark.getBoundingClientRect();
      const drawn = reduced ? 1 : Math.min(1, Math.max(0, (line - rect.top) / (rect.height + 48)));
      mark.style.setProperty("--drawn", `${(drawn * 100).toFixed(1)}%`);
    }

    const words = element.textContent?.trim().split(/\s+/).length ?? 0;
    const minutes = Math.ceil(((1 - read) * words) / WORDS_PER_MINUTE);
    setLeft((current) => (current === minutes ? current : minutes));
  });

  const status = left === null ? " " : left === 0 ? "Finished" : `${left} min left`;

  return (
    <div ref={host} className={cn("grid w-full max-w-4xl gap-8 [--read:0] md:grid-cols-[7rem_1fr]", className)}>
      <div className="sticky top-0 z-10 bg-paper py-2 md:top-8 md:h-[60dvh] md:self-start md:bg-transparent md:py-0">
        <p className="font-mono text-[11px] tracking-[0.1em] text-ink-muted uppercase tabular-nums">{status}</p>
        <div aria-hidden="true" className="relative mt-3 h-px w-full bg-rule md:h-[calc(100%-2rem)] md:w-px">
          <span
            className="absolute top-0 left-0 h-full w-full origin-left bg-ink md:hidden"
            style={{ transform: "scaleX(var(--read))" }}
          />
          <span
            className="absolute top-0 left-0 h-full w-full origin-top bg-ink max-md:hidden"
            style={{ transform: "scaleY(var(--read))" }}
          />
          <span
            className="absolute -top-1 -left-1 size-2 bg-vermilion motion-safe:animate-pulse max-md:hidden"
            style={{ top: "calc(var(--read) * 100% - 4px)" }}
          />
        </div>
      </div>
      <div ref={body} className="min-w-0">
        {children}
      </div>
    </div>
  );
}
