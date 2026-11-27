"use client";

import { useEffect, useRef } from "react";
import { subscribeTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";
import { AsciiGrid, Tone } from "./grid";

export type AsciiFrame = {
  /** Seconds since the scene started. Stops under reduced motion. */
  time: number;
  /** Seconds since the last frame. */
  dt: number;
  /** True when the visitor prefers reduced motion, so changes should apply at once. */
  reduced: boolean;
};

export type AsciiScene = {
  /** A fixed-size picture. Leave this out for a scene that fills its space. */
  size?: { cols: number; rows: number };
  /** Frames a second. Input can still force a redraw between frames. */
  fps?: number;
  /** Set this when input changes the picture, so it redraws without waiting. */
  dirty?: boolean;
  draw(grid: AsciiGrid, frame: AsciiFrame): void;
};

type AsciiCanvasProps = {
  scene: AsciiScene;
  /** Font size in pixels for a scene that fills its space. */
  cell?: number;
  /** Where a fixed-size picture sits in its box. */
  align?: "center" | "bottom" | "bottom-left";
  /** Largest font size for a fixed-size picture. */
  maxFont?: number;
  className?: string;
};

// JetBrains Mono is 0.6em wide. A 1.2em line makes each cell twice as tall as it is wide,
// which is the shape the art was drawn for.
const WIDTH = 0.6;
const HEIGHT = 1.2;

/**
 * Draws an ASCII scene on a canvas. Glyphs take the surrounding text colour, so a scene
 * works on any surface. Pauses off-screen, and under reduced motion it only redraws when
 * a scene reports a change, so input still shows.
 */
export function AsciiCanvas({ scene, cell = 14, align = "center", maxFont = 40, className }: AsciiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const grid = new AsciiGrid();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let visible = true;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let font = cell;
    let originX = 0;
    let originY = 0;
    let family = "monospace";
    let colors: Record<Tone, string> = { 0: "#000", 1: "#000", 2: "#000" };
    let time = 0;
    let last = performance.now();
    let drawn = 0;
    let forced = true;

    function readTheme() {
      if (!canvas) return;
      const style = getComputedStyle(canvas);
      family = style.getPropertyValue("--font-code").trim() || "monospace";
      colors = {
        [Tone.base]: style.color,
        [Tone.muted]: style.color,
        [Tone.accent]: style.getPropertyValue("--vermilion").trim(),
      };
    }

    function layout() {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      if (width < 1 || height < 1) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const size = scene.size;
      if (size) {
        grid.resize(size.cols, size.rows);
        font = Math.min(maxFont, width / (size.cols * WIDTH), height / (size.rows * HEIGHT));
        const artWidth = size.cols * font * WIDTH;
        const artHeight = size.rows * font * HEIGHT;
        originX = align === "bottom-left" ? 0 : (width - artWidth) / 2;
        originY = align === "center" ? (height - artHeight) / 2 : height - artHeight;
      } else {
        font = cell;
        grid.resize(Math.ceil(width / (font * WIDTH)), Math.ceil(height / (font * HEIGHT)));
        originX = 0;
        originY = 0;
      }
      forced = true;
    }

    function paint() {
      if (!context || grid.cols === 0) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.font = `500 ${font}px ${family}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      const cellWidth = font * WIDTH;
      const cellHeight = font * HEIGHT;

      for (const tone of [Tone.muted, Tone.base, Tone.accent]) {
        context.fillStyle = colors[tone];
        context.globalAlpha = tone === Tone.muted ? 0.5 : 1;
        for (let y = 0; y < grid.rows; y++) {
          for (let x = 0; x < grid.cols; x++) {
            const index = y * grid.cols + x;
            const char = grid.chars[index];
            if (!char || char === " " || grid.tones[index] !== tone) continue;
            context.fillText(char, originX + (x + 0.5) * cellWidth, originY + (y + 0.5) * cellHeight);
          }
        }
      }
      context.globalAlpha = 1;
    }

    function render(now: number) {
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const reduced = motion.matches;
      if (!reduced) time += dt;

      const due = !reduced && now - drawn >= 1000 / (scene.fps ?? 24);
      if (due || forced || scene.dirty) {
        const step = reduced ? 0 : Math.min(0.1, (now - drawn) / 1000);
        drawn = now;
        forced = false;
        scene.dirty = false;
        grid.clear();
        scene.draw(grid, { time, dt: step, reduced });
        paint();
      }
      raf = requestAnimationFrame(render);
    }

    function schedule() {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(render);
    }

    const onVisibility = () => schedule();
    const stopThemeWatch = subscribeTheme(() => {
      readTheme();
      forced = true;
    });
    const resizeObserver = new ResizeObserver(layout);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      schedule();
    });

    readTheme();
    layout();
    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    document.fonts?.ready.then(() => {
      forced = true;
    });
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      stopThemeWatch();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [scene, cell, align, maxFont]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("block size-full", className)} />;
}
