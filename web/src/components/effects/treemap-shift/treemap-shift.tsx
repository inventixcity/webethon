"use client";

import { Pause, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type Box, squarify } from "./squarify";
import { useFrame } from "../use-frame";

const GAP = 2;
const PLAY_RATE = 0.5; // steps a second

export type TreemapSeries = { id: string; name: string; values: readonly number[] };

export type TreemapShiftProps = {
  series: readonly TreemapSeries[];
  /** One label for each value in a series, such as the months. */
  steps: readonly string[];
  label: string;
  format?: (value: number) => string;
  className?: string;
};

function valueAt(values: readonly number[], at: number) {
  const clamped = Math.max(0, Math.min(values.length - 1, at));
  const below = Math.floor(clamped);
  const above = Math.min(values.length - 1, below + 1);
  return (values[below] ?? 0) + ((values[above] ?? 0) - (values[below] ?? 0)) * (clamped - below);
}

/** A treemap you can play. Tiles trade space as time runs, and the tint shows who's rising or falling right now. */
export function TreemapShift({ series, steps, label, format = String, className }: TreemapShiftProps) {
  const reduced = useReducedMotion() ?? false;
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const scrubber = useRef<HTMLInputElement>(null);
  const tiles = useRef<(HTMLDivElement | null)[]>([]);
  const shares = useRef<(HTMLSpanElement | null)[]>([]);
  const boxes = useRef<Box[]>([]);
  const size = useRef({ width: 0, height: 0 });
  const position = useRef(0);
  const hovered = useRef(-1);
  const [playing, setPlaying] = useState(true);
  const [step, setStep] = useState(0);
  const [focus, setFocus] = useState(-1);
  // Set after mount, so the server and first client render agree (the preference is unknown on the server).
  const [locked, setLocked] = useState(false);

  const last = steps.length - 1;

  function draw(ease: number) {
    const { width, height } = size.current;
    if (width === 0) return;
    const at = position.current;
    const values = series.map((item) => valueAt(item.values, at));
    const total = values.reduce((sum, value) => sum + value, 0);
    const targets = squarify(values, { x: 0, y: 0, width, height });

    series.forEach((item, index) => {
      const tile = tiles.current[index];
      const target = targets[index];
      if (!tile || !target) return;

      const box = boxes.current[index] ?? target;
      const next = {
        x: box.x + (target.x - box.x) * ease,
        y: box.y + (target.y - box.y) * ease,
        width: box.width + (target.width - box.width) * ease,
        height: box.height + (target.height - box.height) * ease,
      };
      boxes.current[index] = next;

      tile.style.transform = `translate(${next.x.toFixed(1)}px, ${next.y.toFixed(1)}px)`;
      tile.style.width = `${Math.max(0, next.width - GAP).toFixed(1)}px`;
      tile.style.height = `${Math.max(0, next.height - GAP).toFixed(1)}px`;
      tile.dataset.small = next.width < 92 || next.height < 56 ? "true" : "false";

      const value = values[index] ?? 0;
      const before = valueAt(item.values, at - 1) || value;
      const change = Math.max(-1, Math.min(1, (value - before) / before / 0.25));
      tile.style.setProperty("--up", `${Math.max(0, change * 42).toFixed(1)}%`);
      tile.style.setProperty("--down", `${Math.max(0, -change * 16).toFixed(1)}%`);

      const share = shares.current[index];
      const text = `${Math.round((value / total) * 100)}%`;
      if (share && share.textContent !== text) share.textContent = text;

      if (hovered.current === index && tip.current) {
        const sign = value >= before ? "+" : "";
        tip.current.textContent = `${item.name}: ${format(Math.round(value))}, ${sign}${Math.round(((value - before) / before) * 100)}% on last`;
      }
    });

    if (scrubber.current && document.activeElement !== scrubber.current) scrubber.current.value = at.toFixed(2);
    const nearest = Math.round(at);
    setStep((current) => (current === nearest ? current : nearest));
  }

  useFrame(
    host,
    (dt) => {
      if (playing) {
        const next = position.current + dt * PLAY_RATE;
        position.current = next > last ? 0 : next;
      }
      draw(1 - Math.exp(-dt * 10));
    },
    !reduced,
  );

  useEffect(() => {
    setLocked(reduced);
    if (reduced) setPlaying(false);
  }, [reduced]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      size.current = { width: element.clientWidth, height: element.clientHeight };
      boxes.current = [];
      draw(1);
    });
    observer.observe(element);
    return () => observer.disconnect();
    // `draw` reads refs and props the chart keeps for life.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, []);

  function scrub(value: number) {
    setPlaying(false);
    position.current = value;
    draw(reduced ? 1 : 0.5);
  }

  function onPointerMove(event: React.PointerEvent) {
    const box = host.current?.getBoundingClientRect();
    const element = tip.current;
    if (!box || !element) return;
    const flip = event.clientX - box.left > box.width - 260;
    element.style.transform = `translate(${event.clientX - box.left + (flip ? -element.offsetWidth - 14 : 14)}px, ${event.clientY - box.top + 14}px)`;
  }

  return (
    <div className={cn("w-full max-w-5xl", className)}>
      <div
        ref={host}
        aria-hidden="true"
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          hovered.current = -1;
          setFocus(-1);
        }}
        className="relative aspect-[16/9] w-full overflow-hidden max-md:aspect-[4/5]"
      >
        {series.map((item, index) => (
          <div
            key={item.id}
            ref={(element) => {
              tiles.current[index] = element;
            }}
            onPointerEnter={() => {
              hovered.current = index;
              setFocus(index);
            }}
            className="group absolute top-0 left-0 overflow-hidden p-3 text-ink transition-opacity duration-200 [--down:0%] [--up:0%]"
            style={{
              background:
                "color-mix(in oklab, var(--vermilion) var(--up), color-mix(in oklab, var(--ink) var(--down), var(--paper-sunk)))",
              opacity: focus >= 0 && focus !== index ? 0.45 : 1,
            }}
          >
            <span className="block truncate text-sm font-medium group-data-[small=true]:opacity-0">{item.name}</span>
            <span
              ref={(element) => {
                shares.current[index] = element;
              }}
              className="mt-0.5 block font-mono text-xs tabular-nums group-data-[small=true]:opacity-0"
            />
          </div>
        ))}
        <div
          ref={tip}
          className="pointer-events-none absolute top-0 left-0 z-10 bg-ink px-2 py-1 font-mono text-[11px] whitespace-nowrap text-paper"
          style={{ opacity: focus >= 0 ? 1 : 0 }}
        />
      </div>

      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((value) => !value)}
          disabled={locked}
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center bg-ink text-paper disabled:cursor-default disabled:opacity-40"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <input
          ref={scrubber}
          type="range"
          min={0}
          max={last}
          step={0.01}
          defaultValue={0}
          aria-label="Month"
          aria-valuetext={steps[step]}
          onChange={(event) => scrub(Number(event.target.value))}
          className="h-11 min-w-0 flex-1 cursor-ew-resize appearance-none bg-transparent [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-2 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-vermilion [&::-moz-range-track]:h-px [&::-moz-range-track]:bg-ink [&::-webkit-slider-runnable-track]:h-px [&::-webkit-slider-runnable-track]:bg-ink [&::-webkit-slider-thumb]:-mt-3 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-vermilion"
        />
        <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums">{steps[step]}</span>
      </div>

      <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
        <span>Falling</span>
        <span
          aria-hidden="true"
          className="h-2 w-28"
          style={{
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--ink) 16%, var(--paper-sunk)), var(--paper-sunk), color-mix(in oklab, var(--vermilion) 42%, var(--paper-sunk)))",
          }}
        />
        <span>Rising. Area shows size.</span>
      </div>

      <table className="sr-only">
        <caption>
          {label}, {steps[step]}
        </caption>
        <tbody>
          {series.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.name}</th>
              <td>{format(item.values[step] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
