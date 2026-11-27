"use client";

import { useEffect, useRef } from "react";
import { subscribeTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";

export type LiveColors = Record<
  "paper" | "raised" | "sunk" | "ink" | "soft" | "muted" | "accent" | "rule" | "sceneA" | "sceneB" | "sceneC",
  string
>;

export type LiveFrame = {
  width: number;
  height: number;
  time: number;
  dt: number;
  /** True when the visitor prefers reduced motion, so changes should apply at once. */
  reduced: boolean;
  colors: LiveColors;
  /** The heading font's family, for drawing text in the set's own type. */
  headingFont: string;
};

export type LiveScene = {
  /** Set this when input changes the picture, so it redraws under reduced motion. */
  dirty?: boolean;
  draw(context: CanvasRenderingContext2D, frame: LiveFrame): void;
  /** The pointer, in pixels within the canvas. */
  pointer?(x: number, y: number): void;
};

const TOKENS: Record<keyof LiveColors, string> = {
  paper: "--paper",
  raised: "--paper-raised",
  sunk: "--paper-sunk",
  ink: "--ink",
  soft: "--ink-soft",
  muted: "--ink-muted",
  accent: "--vermilion",
  rule: "--rule",
  sceneA: "--scene-a",
  sceneB: "--scene-b",
  sceneC: "--scene-c",
};

/**
 * Runs a scene on a 2D canvas, in the colours of the surface it sits on. Pauses off-screen,
 * follows the pointer, and under reduced motion only redraws when the scene reports a change.
 */
export function LiveCanvas({ scene, className }: { scene: LiveScene; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let visible = true;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let time = 0;
    let last = performance.now();
    let colors = {} as LiveColors;
    let headingFont = "serif";
    let forced = true;

    function readTheme() {
      if (!canvas) return;
      const style = getComputedStyle(canvas);
      colors = Object.fromEntries(
        Object.entries(TOKENS).map(([key, token]) => [key, style.getPropertyValue(token).trim()]),
      ) as LiveColors;
      headingFont = style.getPropertyValue("--font-head").trim() || style.getPropertyValue("--font-display").trim();
      forced = true;
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
      forced = true;
    }

    function render(now: number) {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      const reduced = motion.matches;
      if (!reduced) time += dt;
      if (context && width > 0 && (!reduced || forced || scene.dirty)) {
        forced = false;
        scene.dirty = false;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);
        scene.draw(context, { width, height, time, dt: reduced ? 0 : dt, reduced, colors, headingFont });
      }
      raf = requestAnimationFrame(render);
    }

    function schedule() {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(render);
    }

    function onPointerMove(event: PointerEvent) {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      scene.pointer?.(event.clientX - box.left, event.clientY - box.top);
    }

    const stopThemeWatch = subscribeTheme(readTheme);
    const resizeObserver = new ResizeObserver(layout);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      schedule();
    });

    readTheme();
    layout();
    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", schedule);
    document.fonts?.ready.then(() => {
      forced = true;
    });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      stopThemeWatch();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [scene]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("block size-full", className)} />;
}
