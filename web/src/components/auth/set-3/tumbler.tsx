"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * The spin keeps its own timing and overshoot. It is the wheel's character, so it is not a motion token.
 * Reduced motion lands the digit at once, through the hook, because an inline transition ignores motion-reduce classes.
 */
const SPIN = "transform 620ms cubic-bezier(0.3, 1.5, 0.5, 1)";

const DIGITS = 10;
const TURNS = 4;
const STRIP = Array.from({ length: DIGITS * TURNS }, (_, index) => index % DIGITS);

type TumblerProps = {
  /** The digit to show, or undefined for a wheel that hasn't been set. */
  digit?: string;
  active?: boolean;
  /** Turns the digit vermilion once the code is accepted. */
  open?: boolean;
};

/** One number wheel. Setting a digit spins it forward a full turn, and it overshoots as it lands. */
export function Tumbler({ digit, active = false, open = false }: TumblerProps) {
  const reduced = useReducedMotion();
  // Starts a turn in, so there's always a digit showing above the sight line.
  const [position, setPosition] = useState(DIGITS);
  const turn = useRef(1);
  const previous = useRef(digit);

  useEffect(() => {
    if (digit === previous.current) return;
    previous.current = digit;
    if (digit === undefined) {
      turn.current = 1;
      setPosition(DIGITS);
      return;
    }
    turn.current = Math.min(TURNS - 1, turn.current + 1);
    setPosition(turn.current * DIGITS + Number(digit));
  }, [digit]);

  return (
    <div
      className={cn(
        "relative h-[calc(var(--cell)*3)] overflow-hidden border border-rule bg-paper transition-colors duration-(--duration-base)",
        active && "border-ink",
      )}
      style={{ maskImage: "linear-gradient(transparent, black 32%, black 68%, transparent)" }}
    >
      <div
        style={{
          transform: `translateY(calc(var(--cell) * ${1 - position}))`,
          transition: reduced ? "none" : SPIN,
        }}
      >
        {STRIP.map((value, index) => (
          <div
            // The strip is a fixed run of digits.
            key={index}
            className={cn(
              "grid h-[var(--cell)] place-items-center font-mono text-[calc(var(--cell)*0.6)] leading-none font-medium tabular-nums transition-colors duration-(--duration-slow)",
              digit === undefined ? "text-ink/25" : "text-ink",
              open && index === position && "text-vermilion-deep",
            )}
          >
            {value}
          </div>
        ))}
      </div>
    </div>
  );
}
