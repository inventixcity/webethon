"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const ROW = 44;
const VISIBLE = 5;
const RADIUS = (ROW * VISIBLE) / 2.4;

export type WheelPickerProps = {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
};

/** A 3D picker drum with inertia. Flick it, drag it, scroll it, or use the arrow keys, and it clicks to a row. */
export function WheelPicker({ items, value, onChange, label, className }: WheelPickerProps) {
  const [offset, setOffset] = useState(() => Math.max(0, items.indexOf(value)));
  const position = useRef(offset);
  const velocity = useRef(0);
  const raf = useRef(0);
  const drag = useRef<{ y: number; start: number; lastY: number; lastTime: number } | null>(null);

  const limit = (next: number) => Math.min(items.length - 1, Math.max(0, next));

  function settle() {
    cancelAnimationFrame(raf.current);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      velocity.current *= Math.exp(-4.5 * dt);
      position.current = limit(position.current + velocity.current * dt);
      // Once it slows, a spring pulls it into the nearest row.
      if (Math.abs(velocity.current) < 3) {
        const target = Math.round(position.current);
        position.current += (target - position.current) * (1 - Math.exp(-16 * dt));
        if (Math.abs(target - position.current) < 0.004) {
          position.current = target;
          setOffset(target);
          const next = items[target];
          if (next !== undefined && next !== value) onChange(next);
          return;
        }
      }
      setOffset(position.current);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  function nudge(by: number) {
    velocity.current = 0;
    position.current = limit(Math.round(position.current) + by);
    settle();
  }

  return (
    <div
      role="spinbutton"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={items[Math.round(offset)]}
      aria-valuenow={Math.round(offset)}
      aria-valuemin={0}
      aria-valuemax={items.length - 1}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        cancelAnimationFrame(raf.current);
        drag.current = { y: event.clientY, start: position.current, lastY: event.clientY, lastTime: performance.now() };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        const now = performance.now();
        const moved = (state.y - event.clientY) / ROW;
        position.current = limit(state.start + moved);
        velocity.current = ((state.lastY - event.clientY) / ROW / Math.max(1, now - state.lastTime)) * 1000;
        state.lastY = event.clientY;
        state.lastTime = now;
        setOffset(position.current);
      }}
      onPointerUp={() => {
        drag.current = null;
        settle();
      }}
      onWheel={(event) => nudge(Math.sign(event.deltaY))}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          nudge(1);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          nudge(-1);
        }
      }}
      className={cn("relative w-24 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing", className)}
      style={{ height: ROW * VISIBLE, perspective: 500 }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 border-y border-ink" style={{ height: ROW }} />
      <div className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
        {items.map((item, index) => {
          const distance = index - offset;
          if (Math.abs(distance) > VISIBLE) return null;
          const angle = distance * (ROW / RADIUS);
          return (
            <div
              key={item}
              className="absolute inset-x-0 top-1/2 flex items-center justify-center font-mono text-xl tabular-nums"
              style={{
                height: ROW,
                marginTop: -ROW / 2,
                opacity: Math.max(0.12, 1 - Math.abs(distance) * 0.3),
                transform: `rotateX(${-angle}rad) translateZ(${RADIUS}px)`,
                backfaceVisibility: "hidden",
              }}
            >
              {item}
            </div>
          );
        })}
      </div>
    </div>
  );
}
