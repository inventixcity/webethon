"use client";

import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const CENTRE_X = 200;
const CENTRE_Y = 262;
const SWEEP = 52; // degrees either side of upright
const RADIUS = 210;
const TICKS = 41;
const WEAK_TICKS = 11; // the end of the scale that's marked in vermilion

const polar = (degrees: number, radius: number) => {
  const angle = ((degrees - 90) * Math.PI) / 180;
  return {
    x: Math.round((CENTRE_X + radius * Math.cos(angle)) * 100) / 100,
    y: Math.round((CENTRE_Y + radius * Math.sin(angle)) * 100) / 100,
  };
};

const ticks = Array.from({ length: TICKS }, (_, index) => {
  const major = index % 5 === 0;
  const degrees = -SWEEP + (index / (TICKS - 1)) * SWEEP * 2;
  return {
    index,
    from: polar(degrees, RADIUS),
    to: polar(degrees, RADIUS - (major ? 22 : 12)),
    major,
    weak: index < WEAK_TICKS,
  };
});

const labels = [
  { text: "Weak", ...polar(-36, 158), tone: "fill-vermilion-deep" },
  { text: "Fair", ...polar(0, 160), tone: "fill-ink-muted" },
  { text: "Strong", ...polar(36, 158), tone: "fill-ink" },
];

type Lamp = { label: string; on: boolean };

type StrengthGaugeProps = {
  /** From 0 to 1. */
  strength: number;
  /** Changes on each keystroke, so the needle twitches as you type. */
  typed: number;
  lamps: Lamp[];
  className?: string;
};

/** An analogue meter. The needle is a loose spring, so it overshoots and settles like the real thing. */
export function StrengthGauge({ strength, typed, lamps, className }: StrengthGaugeProps) {
  const reduced = useReducedMotion();
  const target = -SWEEP + strength * SWEEP * 2;
  const needle = useSpring(-SWEEP, { stiffness: 150, damping: 9, mass: 0.7 });
  const tipX = useTransform(needle, (degrees) => polar(degrees, RADIUS - 6).x);
  const tipY = useTransform(needle, (degrees) => polar(degrees, RADIUS - 6).y);
  const lastTyped = useRef(typed);

  useEffect(() => {
    if (reduced) {
      needle.jump(target);
      return;
    }
    needle.set(target);
  }, [needle, target, reduced]);

  useEffect(() => {
    if (typed === lastTyped.current || reduced) return;
    lastTyped.current = typed;
    needle.set(target + 7);
    const id = window.setTimeout(() => needle.set(target), 60);
    return () => window.clearTimeout(id);
  }, [typed, target, needle, reduced]);

  return (
    <div className={cn("w-full max-w-2xl border border-ink bg-paper-raised", className)}>
      <svg viewBox="0 0 400 250" role="img" aria-label="Password strength meter" className="block w-full">
        {ticks.map((tick) => (
          <line
            key={tick.index}
            x1={tick.from.x}
            y1={tick.from.y}
            x2={tick.to.x}
            y2={tick.to.y}
            stroke={tick.weak ? "var(--vermilion)" : "var(--ink)"}
            strokeWidth={tick.major ? 1.6 : 0.8}
          />
        ))}
        {labels.map((label) => (
          <text
            key={label.text}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            className={cn("font-mono text-[9px] tracking-[0.14em] uppercase", label.tone)}
          >
            {label.text}
          </text>
        ))}
        <text x="14" y="22" className="fill-ink-muted font-mono text-[8px] tracking-[0.14em] uppercase">
          Password strength
        </text>
        <motion.line
          x1={CENTRE_X}
          y1={CENTRE_Y}
          x2={tipX}
          y2={tipY}
          stroke="var(--vermilion)"
          strokeWidth="1.8"
        />
        <rect x="150" y="226" width="100" height="24" fill="var(--ink)" />
      </svg>
      <ul className="grid grid-cols-5 divide-x divide-rule border-t border-ink font-mono text-[10px] tracking-[0.1em] uppercase">
        {lamps.map((lamp) => (
          <li key={lamp.label} className="flex flex-col items-center gap-2 px-1 py-3 text-center">
            <span
              aria-hidden="true"
              className={cn(
                "size-3 transition-colors duration-(--duration-fast) motion-reduce:transition-none",
                lamp.on ? "bg-vermilion" : "bg-ink/15",
              )}
            />
            {lamp.label}
            <span className="sr-only">{lamp.on ? " (on)" : " (off)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
