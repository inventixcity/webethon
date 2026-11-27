"use client";

import { motion, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const SWEEP = 270; // degrees from the lowest to the highest value

export type RotaryKnobProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** The click size. Each step is a detent the knob settles into. */
  step?: number;
  label: string;
  /** Formats the readout, for example to add a unit. */
  format?: (value: number) => string;
  className?: string;
};

/** A hardware-style knob with detents. Drag round it, scroll on it, or use the arrow keys. */
export function RotaryKnob({ value, onChange, min = 0, max = 100, step = 5, label, format = String, className }: RotaryKnobProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const angleOf = (next: number) => -SWEEP / 2 + ((next - min) / (max - min)) * SWEEP;
  const angle = useSpring(angleOf(value), { stiffness: 420, damping: 24 });
  const ticks = Math.round((max - min) / step);

  useEffect(() => {
    if (reduced) angle.jump(angleOf(value));
    else angle.set(angleOf(value));
    // `angleOf` only depends on the range, which is fixed for a knob's life.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, [value, reduced, angle]);

  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));

  function setFromPointer(event: React.PointerEvent) {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const limited = Math.min(SWEEP / 2, Math.max(-SWEEP / 2, degrees));
    onChange(clamp(min + ((limited + SWEEP / 2) / SWEEP) * (max - min)));
  }

  return (
    <div className={cn("grid justify-items-center gap-3", className)}>
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons) setFromPointer(event);
        }}
        onWheel={(event) => onChange(clamp(value - Math.sign(event.deltaY) * step))}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowRight") onChange(clamp(value + step));
          if (event.key === "ArrowDown" || event.key === "ArrowLeft") onChange(clamp(value - step));
        }}
        className="relative size-44 cursor-grab touch-none select-none active:cursor-grabbing"
      >
        {Array.from({ length: ticks + 1 }, (_, index) => {
          const tickValue = min + index * step;
          return (
            <span
              // Ticks are fixed marks around the dial.
              key={index}
              className="absolute top-0 left-1/2 h-1/2 w-px origin-bottom"
              style={{ transform: `rotate(${-SWEEP / 2 + (index / ticks) * SWEEP}deg)` }}
            >
              <span className={cn("block h-2 w-px", tickValue <= value ? "bg-vermilion" : "bg-ink/25")} />
            </span>
          );
        })}
        <motion.div style={{ rotate: angle }} className="absolute inset-6 border border-ink bg-paper-raised">
          <span className="absolute top-2 left-1/2 h-6 w-1 -translate-x-1/2 bg-ink" />
        </motion.div>
      </div>
      <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</p>
      <p className="text-3xl font-semibold tabular-nums tracking-[-0.03em]">{format(value)}</p>
    </div>
  );
}
