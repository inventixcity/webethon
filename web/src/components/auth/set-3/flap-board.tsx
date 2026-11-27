"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./flap-board.module.css";

const ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@._-*:/+!?";
const FLIP_MS = 44;
/** A real board can take seconds. This keeps typing feeling instant while still clattering. */
const MAX_FLIPS = 6;
const STAGGER_MS = 14;

function FlapCell({ target, delay, accent }: { target: string; delay: number; accent: boolean }) {
  const [state, setState] = useState({ shown: " ", previous: " ", flip: 0 });
  const position = useRef(0);

  useEffect(() => {
    const size = ALPHABET.length;
    const goal = Math.max(0, ALPHABET.indexOf(target));
    if (position.current === goal) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      position.current = goal;
      setState((current) => ({ shown: target, previous: target, flip: current.flip }));
      return;
    }

    // Start a few flips short of the goal, so the letter arrives quickly but never just appears.
    if ((goal - position.current + size) % size > MAX_FLIPS) position.current = (goal - MAX_FLIPS + size) % size;

    let timer = 0;
    const flip = () => {
      position.current = (position.current + 1) % size;
      const next = ALPHABET[position.current] ?? " ";
      setState((current) => ({ shown: next, previous: current.shown, flip: current.flip + 1 }));
      if (position.current !== goal) timer = window.setTimeout(flip, FLIP_MS * 2);
    };
    timer = window.setTimeout(flip, delay);
    return () => window.clearTimeout(timer);
  }, [target, delay]);

  return (
    <div
      className={cn(styles.cell, accent && styles.accent)}
      style={{ "--flip": `${FLIP_MS}ms` } as React.CSSProperties}
    >
      <div className={cn(styles.half, styles.upper)}>
        <span className={styles.glyph}>{state.shown}</span>
      </div>
      <div className={cn(styles.half, styles.lower)}>
        <span className={styles.glyph}>{state.previous}</span>
      </div>
      {/* Remounting on each flip restarts the two leaves' animations. */}
      <div key={`fall-${state.flip}`} className={cn(styles.half, styles.upper, styles.leafFalling)}>
        <span className={styles.glyph}>{state.previous}</span>
      </div>
      <div key={`land-${state.flip}`} className={cn(styles.half, styles.lower, styles.leafLanding)}>
        <span className={styles.glyph}>{state.shown}</span>
      </div>
    </div>
  );
}

export type FlapRow = { text: string; accent?: boolean };

type FlapBoardProps = {
  rows: FlapRow[];
  /** Characters on each row. Longer text keeps its end, so typing stays in view. */
  columns?: number;
  className?: string;
};

/** A departure board you control: change the text and the changed letters clatter over. */
export function FlapBoard({ rows, columns = 20, className }: FlapBoardProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(styles.board, className)}
      style={{ "--cols": columns } as React.CSSProperties}
    >
      <div className={styles.rows}>
        {rows.map((row, rowIndex) => {
          const text = row.text.toUpperCase().slice(-columns).padEnd(columns, " ");
          return (
            // Rows are fixed slots on the board, so their position is their identity.
            <div key={rowIndex} className={styles.row}>
              {Array.from(text).map((char, column) => (
                <FlapCell
                  key={column}
                  target={ALPHABET.includes(char) ? char : " "}
                  delay={column * STAGGER_MS}
                  accent={row.accent ?? false}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
