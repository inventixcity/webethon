"use client";

import { ChevronsLeftRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useFrame } from "../use-frame";

export type CompareSliderProps = {
  before: React.ReactNode;
  after: React.ReactNode;
  beforeLabel: string;
  afterLabel: string;
  label: string;
  className?: string;
};

const IDLE_AFTER = 2600; // ms without input before it starts swaying again

/** Two versions of the same thing with a divider between them. It follows the pointer, and sways when left alone. */
export function CompareSlider({ before, after, beforeLabel, afterLabel, label, className }: CompareSliderProps) {
  const reduced = useReducedMotion() ?? false;
  const host = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const position = useRef(50);
  const target = useRef(50);
  const touched = useRef(-Infinity);
  const [value, setValue] = useState(50);

  function paint() {
    const at = position.current;
    if (top.current) top.current.style.clipPath = `inset(0 ${100 - at}% 0 0)`;
    if (line.current) line.current.style.left = `${at}%`;
  }

  function setTarget(next: number) {
    const clean = Math.min(100, Math.max(0, next));
    target.current = clean;
    touched.current = performance.now();
    setValue(Math.round(clean));
    if (reduced) {
      position.current = clean;
      paint();
    }
  }

  useFrame(
    host,
    (dt, time) => {
      if (performance.now() - touched.current > IDLE_AFTER) target.current = 50 + Math.sin(time * 0.7) * 16;
      position.current += (target.current - position.current) * (1 - Math.exp(-dt * 13));
      paint();
    },
    !reduced,
  );

  function fromPointer(event: React.PointerEvent) {
    const box = host.current?.getBoundingClientRect();
    if (box) setTarget(((event.clientX - box.left) / box.width) * 100);
  }

  const chip = "absolute top-3 z-10 bg-paper px-2 py-1 font-mono text-[11px] tracking-[0.1em] text-ink uppercase";

  return (
    <div
      ref={host}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" || event.buttons) fromPointer(event);
      }}
      className={cn("relative isolate w-full max-w-4xl cursor-ew-resize touch-pan-y overflow-hidden border border-ink select-none", className)}
    >
      <div>
        {after}
        <span className={cn(chip, "right-3")}>{afterLabel}</span>
      </div>
      <div ref={top} className="absolute inset-0" style={{ clipPath: "inset(0 50% 0 0)" }}>
        {before}
        <span className={cn(chip, "left-3")}>{beforeLabel}</span>
      </div>
      <div ref={line} className="absolute inset-y-0 z-20 w-px bg-vermilion" style={{ left: "50%" }}>
        <div
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          onKeyDown={(event) => {
            const moves: Record<string, number> = {
              ArrowLeft: target.current - 5,
              ArrowRight: target.current + 5,
              Home: 0,
              End: 100,
            };
            const next = moves[event.key];
            if (next === undefined) return;
            event.preventDefault();
            setTarget(next);
          }}
          className="absolute top-1/2 left-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-vermilion text-white"
        >
          <ChevronsLeftRight className="size-5" />
        </div>
      </div>
    </div>
  );
}
