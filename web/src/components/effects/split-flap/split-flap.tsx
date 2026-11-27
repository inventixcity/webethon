"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { createMotionClock } from "../invert-lens/motion-clock";
import styles from "./split-flap.module.css";

export interface SplitFlapProps {
  /** Values to cycle through. Numbers are accepted; caller controls number formatting. */
  phrases?: readonly (string | number)[];
  /** Fixed cells, defaults to longest phrase. Values longer than this are clipped. Maximum 40. */
  columns?: number;
  /** Seconds per phrase, including the staggered mechanical transition. Minimum 6. */
  interval?: number;
  /** Optional accessible name prepended to the settled value. */
  label?: string;
  className?: string;
}

const defaultPhrases = ["MAKE", "MOVE", "GROW"];
const alphabet = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:+-/";

export function SplitFlap({ phrases = defaultPhrases, columns, interval = 7, label, className }: SplitFlapProps) {
  const host = useRef<HTMLDivElement>(null);
  const values = useMemo(() => (phrases.length ? phrases : [""]).map((value) => String(value).toUpperCase()), [phrases]);
  const count = Math.max(1, Math.min(40, Math.floor(columns ?? Math.max(...values.map((value) => Array.from(value).length)))));
  const characters = (value: string) => Array.from(value).slice(0, count).concat(Array(count).fill(" ")).slice(0, count) as string[];
  const first = characters(values[0]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const cells = Array.from(element.querySelectorAll<HTMLElement>("[data-flap]"));
    const parts = cells.map((cell) => ({
      letters: Array.from(cell.querySelectorAll<HTMLElement>("[data-letter]")),
      top: cell.querySelector<HTMLElement>("[data-moving-top]")!,
      bottom: cell.querySelector<HTMLElement>("[data-moving-bottom]")!,
      shades: Array.from(cell.querySelectorAll<HTMLElement>("[data-shade]")),
      signature: "",
    }));
    const padded = values.map((value) => Array.from(value).slice(0, count).concat(Array(count).fill(" ")).slice(0, count) as string[]);
    const cycle = Math.max(6, interval);
    let lastLabel = "";
    const clock = createMotionClock(element, ({ time, reduced }) => {
      const generation = reduced ? 0 : Math.floor(time / cycle);
      const local = reduced ? 0 : time % cycle;
      const target = padded[generation % padded.length];
      const previous = padded[(generation - 1 + padded.length) % padded.length];
      let settled = true;
      parts.forEach((part, i) => {
        const start = i * Math.min(0.075, 1 / count);
        const flips = 3 + i % 4;
        const duration = 0.19;
        const progress = (local - start) / duration;
        const finished = generation === 0 || reduced || progress >= flips || target[i] === previous[i];
        const step = Math.max(0, Math.floor(progress));
        const fraction = Math.max(0, Math.min(1, progress - step));
        const intermediate = (n: number) => n === 0 ? previous[i] : n >= flips ? target[i] : alphabet[(Math.max(0, alphabet.indexOf(previous[i])) + n * 3 + i) % alphabet.length];
        const oldChar = finished ? target[i] : intermediate(step);
        const newChar = finished || progress < 0 ? oldChar : intermediate(step + 1);
        const signature = `${oldChar}\u0000${newChar}`;
        if (signature !== part.signature) {
          // Resting top = destination; resting bottom = departure. Each moving leaf
          // carries only one half. They meet exactly at the physical center hinge.
          [newChar, oldChar, oldChar, newChar].forEach((char, index) => { part.letters[index].textContent = char; });
          part.signature = signature;
        }
        if (finished || progress < 0) {
          part.top.style.transform = "rotateX(0deg)";
          part.bottom.style.transform = "rotateX(90deg)";
          part.shades[0].style.opacity = "0"; part.shades[1].style.opacity = "0";
        } else {
          settled = false;
          const firstHalf = Math.min(1, fraction * 2);
          const secondHalf = Math.max(0, (fraction - 0.5) * 2);
          part.top.style.transform = `rotateX(${-90 * firstHalf * firstHalf}deg)`;
          // Falling lower leaf decelerates into the frame; no blur or soft shadow.
          part.bottom.style.transform = `rotateX(${90 * (1 - Math.sin(secondHalf * Math.PI / 2))}deg)`;
          part.shades[0].style.opacity = `${firstHalf * 0.4}`;
          part.shades[1].style.opacity = `${(1 - secondHalf) * 0.35}`;
        }
      });
      const accessible = `${label ? `${label}: ` : ""}${values[generation % values.length]}`;
      if (settled && accessible !== lastLabel) { element.setAttribute("aria-label", accessible); lastLabel = accessible; }
    });
    return () => clock.dispose();
  }, [values, count, interval, label]);

  return (
    <div ref={host} role="img" aria-label={`${label ? `${label}: ` : ""}${values[0]}`} className={cn(styles.board, className)} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {first.map((char, i) => (
        <div key={i} data-flap aria-hidden="true" className={styles.cell}>
          <div className={cn(styles.half, styles.top)}><span data-letter className={styles.letter}>{char}</span></div>
          <div className={cn(styles.half, styles.bottom)}><span data-letter className={styles.letter}>{char}</span></div>
          <div data-moving-top className={cn(styles.half, styles.top, styles.movingTop)}><span data-letter className={styles.letter}>{char}</span><span data-shade className={styles.shade} /></div>
          <div data-moving-bottom className={cn(styles.half, styles.bottom, styles.movingBottom)} style={{ transform: "rotateX(90deg)" }}><span data-letter className={styles.letter}>{char}</span><span data-shade className={styles.shade} /></div>
          <div className={styles.seam} />
        </div>
      ))}
    </div>
  );
}
