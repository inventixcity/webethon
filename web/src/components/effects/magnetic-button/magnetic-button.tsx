"use client";

import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SPRING = { stiffness: 260, damping: 18, mass: 0.5 };

export type MagneticButtonProps = React.ComponentProps<"button"> & {
  /** How far the button leans toward the pointer, from 0 to 1. */
  pull?: number;
};

/** A button that leans toward the pointer. Its fill grows from the exact point the pointer came in. */
export function MagneticButton({ pull = 0.32, className, children, ...props }: MagneticButtonProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, SPRING);
  const springY = useSpring(y, SPRING);
  const labelX = useSpring(0, SPRING);
  const labelY = useSpring(0, SPRING);
  const [entry, setEntry] = useState({ top: 50, right: 50, bottom: 50, left: 50, open: false });

  function onMove(event: React.PointerEvent) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || reduced) return;
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    x.set(dx * pull);
    y.set(dy * pull);
    labelX.set(dx * pull * 0.5);
    labelY.set(dy * pull * 0.5);
  }

  function onEnter(event: React.PointerEvent) {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = ((event.clientX - box.left) / box.width) * 100;
    const top = ((event.clientY - box.top) / box.height) * 100;
    setEntry({ top, left, right: 100 - left, bottom: 100 - top, open: false });
    requestAnimationFrame(() => setEntry((current) => ({ ...current, open: true })));
  }

  function onLeave() {
    x.set(0);
    y.set(0);
    labelX.set(0);
    labelY.set(0);
    setEntry((current) => ({ ...current, open: false }));
  }

  const { top, right, bottom, left, open } = entry;

  return (
    <motion.button
      ref={ref}
      type="button"
      style={{ x: springX, y: springY }}
      onPointerMove={onMove}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className={cn(
        "relative isolate h-16 cursor-pointer overflow-hidden border border-ink bg-paper px-10 font-mono text-xs tracking-[0.14em] uppercase",
        className,
      )}
      {...(props as React.ComponentProps<typeof motion.button>)}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-ink transition-[clip-path] duration-500 ease-editorial"
        style={{ clipPath: open ? "inset(0)" : `inset(${top}% ${right}% ${bottom}% ${left}%)` }}
      />
      <motion.span style={{ x: labelX, y: labelY }} className="relative block text-white mix-blend-difference">
        {children}
      </motion.span>
    </motion.button>
  );
}
