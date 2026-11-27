"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useFrame } from "../use-frame";

export type ExpandingPanel = {
  id: string;
  kicker: string;
  title: string;
  body: string;
};

export type ExpandingPanelsProps = {
  panels: readonly ExpandingPanel[];
  className?: string;
};

const SPREAD = 1.15; // how quickly the swell falls away from its centre
const SWELL = 6; // how much wider the centre panel gets

/** A row of panels that swells under the pointer like a lens, and rolls slowly by itself when left alone. */
export function ExpandingPanels({ panels, className }: ExpandingPanelsProps) {
  const reduced = useReducedMotion() ?? false;
  const host = useRef<HTMLDivElement>(null);
  const elements = useRef<(HTMLButtonElement | null)[]>([]);
  const grow = useRef(panels.map(() => 1));
  const pointer = useRef<number | null>(null);
  const chosen = useRef(0);

  function paint(center: number, ease: number) {
    panels.forEach((_, index) => {
      const element = elements.current[index];
      const current = grow.current[index] ?? 1;
      if (!element) return;
      const distance = index - center;
      const next = current + (1 + SWELL * Math.exp(-distance * distance * SPREAD) - current) * ease;
      grow.current[index] = next;
      element.style.flexGrow = next.toFixed(3);
      element.style.setProperty("--open", Math.min(1, Math.max(0, (next - 3) / 3)).toFixed(3));
    });
  }

  useFrame(
    host,
    (dt, time) => {
      const roll = ((Math.sin(time * 0.32) + 1) / 2) * (panels.length - 1);
      paint(pointer.current ?? (chosen.current >= 0 ? chosen.current : roll), 1 - Math.exp(-dt * 9));
    },
    !reduced,
  );

  useEffect(() => {
    chosen.current = reduced ? 0 : -1;
    if (reduced) paint(0, 1);
    // `paint` reads refs only, so it never goes stale.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, [reduced]);

  function point(event: React.PointerEvent) {
    const box = host.current?.getBoundingClientRect();
    if (!box || event.pointerType !== "mouse") return;
    const horizontal = box.width > box.height;
    const along = horizontal ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
    pointer.current = along * panels.length - 0.5;
    if (reduced) paint(pointer.current, 1);
  }

  function choose(index: number) {
    chosen.current = index;
    if (reduced) paint(index, 1);
  }

  return (
    <div
      ref={host}
      onPointerMove={point}
      onPointerLeave={() => {
        pointer.current = null;
        if (reduced) paint(chosen.current, 1);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) chosen.current = reduced ? 0 : -1;
      }}
      className={cn("flex h-[34rem] w-full max-w-6xl gap-0.5 max-md:h-[40rem] max-md:flex-col", className)}
    >
      {panels.map((panel, index) => (
        <button
          key={panel.id}
          ref={(element) => {
            elements.current[index] = element;
          }}
          type="button"
          onFocus={() => choose(index)}
          onClick={() => choose(index)}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 basis-0 cursor-pointer overflow-hidden p-5 text-left [--open:0]",
            // A tonal ramp runs across the row, ending on the full ink panel.
            index === panels.length - 1 ? "bg-ink text-paper" : "text-ink",
          )}
          style={
            index === panels.length - 1
              ? undefined
              : { background: `color-mix(in oklab, var(--ink) ${5 + index * 7}%, var(--paper))` }
          }
        >
          <span className="absolute top-5 left-5 font-mono text-[11px] tracking-[0.12em]">{String(index + 1).padStart(2, "0")}</span>
          <span
            aria-hidden="true"
            className="absolute bottom-5 left-5 text-lg font-semibold whitespace-nowrap [writing-mode:vertical-rl] max-md:bottom-auto max-md:top-5 max-md:left-14 max-md:[writing-mode:horizontal-tb]"
            style={{ opacity: "calc(1 - var(--open) * 3)" }}
          >
            {panel.title}
          </span>
          <span
            className="absolute right-5 bottom-5 left-5 block w-[min(24rem,calc(100vw-5rem))]"
            style={{ opacity: "max(0, calc((var(--open) - 0.4) * 1.67))", transform: "translateY(calc((1 - var(--open)) * 16px))" }}
          >
            <span className="block font-mono text-[11px] tracking-[0.12em] uppercase opacity-70">{panel.kicker}</span>
            <span className="mt-2 block text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.05] font-semibold tracking-[-0.03em]">
              {panel.title}
            </span>
            <span className="mt-3 block text-sm opacity-80">{panel.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
