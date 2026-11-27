"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { animateSurface } from "../ink-tide/runtime";

export interface WarpGridProps {
  /** Accessible, visible foreground headline. */
  headline?: string;
  /** Optional supporting copy beneath the headline. */
  description?: string;
  /** Resting cell width in CSS pixels, clamped to 24–96. */
  cellSize?: number;
  /** Ripple deformation in CSS pixels, clamped to 0–80. */
  amplitude?: number;
  /** Section sizing and layout overrides. */
  className?: string;
}

/** A continuous displacement field preserves shared cell corners as the lattice bends. */
export function WarpGrid({ headline = "Order,\nin motion.", description, cellSize = 48, amplitude = 36, className }: WarpGridProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return animateSurface(ref.current, s => {
      const ctx = s.canvas.getContext("2d", { alpha: false });
      if (!ctx) return null;
      const cell = Math.min(96, Math.max(24, cellSize));
      const strength = Math.min(80, Math.max(0, amplitude));
      let cols = 0, rows = 0;
      let points = new Float32Array(0);
      let peaks = new Float32Array(0);
      let px = -1000, py = -1000, attraction = 0;
      const path = (a: number, b: number, c: number, d: number) => {
        ctx.moveTo(points[a * 2], points[a * 2 + 1]);
        ctx.lineTo(points[b * 2], points[b * 2 + 1]);
        ctx.lineTo(points[c * 2], points[c * 2 + 1]);
        ctx.lineTo(points[d * 2], points[d * 2 + 1]); ctx.closePath();
      };
      return {
        resize() {
          cols = Math.ceil(s.width / cell) + 7; rows = Math.ceil(s.height / cell) + 7;
          points = new Float32Array(cols * rows * 2); peaks = new Float32Array(cols * rows);
        },
        draw() {
          const time = s.still ? 6 : s.time + 6;
          const smoothing = 1 - Math.exp(-s.dt * 6);
          if (s.pointer.active && !s.still) {
            if (px === -1000) { px = s.pointer.x; py = s.pointer.y; }
            px += (s.pointer.x - px) * smoothing; py += (s.pointer.y - py) * smoothing;
          }
          if (s.still) attraction = 0;
          else attraction += ((s.pointer.active ? 1 : 0) - attraction) * smoothing;
          ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
          ctx.fillStyle = s.colors.paper; ctx.fillRect(0, 0, s.width, s.height);
          let accent = -1, best = -Infinity;
          for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            const i = y * cols + x, ox = (x - 3) * cell, oy = (y - 3) * cell;
            const dx = ox - s.width * .67, dy = oy - s.height * .55;
            const distance = Math.hypot(dx, dy) || 1;
            const phase = distance * .014 - time * .6;
            const wave = Math.sin(phase);
            const displacement = wave * strength * (.45 + .55 * Math.min(distance / 250, 1));
            const mx = px - ox, my = py - oy;
            const gravity = attraction * .28 * Math.exp(-(mx * mx + my * my) / 38000);
            points[i * 2] = ox + dx / distance * displacement + mx * gravity;
            points[i * 2 + 1] = oy + dy / distance * displacement + my * gravity;
            peaks[i] = wave;
            if (x < cols - 1 && y < rows - 1 && ox > s.width * .42 && ox < s.width - cell && oy > 0 && oy < s.height - cell) {
              const score = wave - Math.abs(oy - s.height * (.5 + .22 * Math.sin(time * .18))) / s.height * .4;
              if (score > best) { best = score; accent = i; }
            }
          }
          ctx.fillStyle = s.colors.ink; ctx.beginPath();
          for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
            const i = y * cols + x;
            // A narrow crest, staggered by cell parity, reads as ink travelling through the mesh.
            if (peaks[i] > .975 && (x + y) % 3 !== 0 && i !== accent) path(i, i + 1, i + cols + 1, i + cols);
          }
          ctx.fill();
          if (accent >= 0) { ctx.fillStyle = s.colors.accent; ctx.beginPath(); path(accent, accent + 1, accent + cols + 1, accent + cols); ctx.fill(); }
          ctx.strokeStyle = s.colors.rule; ctx.lineWidth = .8; ctx.beginPath();
          for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            if (x === 0) ctx.moveTo(points[i * 2], points[i * 2 + 1]);
            else ctx.lineTo(points[i * 2], points[i * 2 + 1]);
          }
          for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) {
            const i = y * cols + x;
            if (y === 0) ctx.moveTo(points[i * 2], points[i * 2 + 1]);
            else ctx.lineTo(points[i * 2], points[i * 2 + 1]);
          }
          ctx.stroke();
        },
      };
    });
  }, [cellSize, amplitude]);
  return <section className={cn("relative isolate min-h-[560px] overflow-hidden bg-paper font-sans text-ink md:min-h-[720px]", className)}>
    <canvas ref={ref} aria-hidden="true" className="absolute inset-0 h-full w-full" />
    <div className="pointer-events-none absolute inset-x-6 top-12 md:inset-x-[5.5%] md:top-20">
      <h2 className="max-w-[900px] whitespace-pre-line text-[clamp(60px,10.2vw,160px)] leading-[.94] font-semibold tracking-[-0.03em]">
        {headline.split("\n").map((line, i) => <span className="table bg-paper pr-3 pb-1" key={i}>{line}</span>)}
      </h2>
      {description && <p className="mt-8 max-w-[270px] bg-paper py-2 pr-4 text-base leading-relaxed text-ink-soft">{description}</p>}
    </div>
  </section>;
}
