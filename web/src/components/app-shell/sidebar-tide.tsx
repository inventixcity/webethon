"use client";

import { useEffect, useRef } from "react";
import { subscribeTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";

type Palette = { ink: string; cobalt: string; amber: string };

function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  return {
    ink: css.getPropertyValue("--ink").trim() || "#12110e",
    cobalt: css.getPropertyValue("--cobalt").trim() || "#2b4fd8",
    amber: css.getPropertyValue("--amber").trim() || "#e0862c",
  };
}

const CELL = 7;

/**
 * A slow halftone tide for the sidebar header. Dots swell below a moving surface, with a cobalt crest and the odd amber
 * dot. It is a canvas, drawn from the theme tokens, so it recolours on a mode change. It pauses off-screen and when the
 * tab is hidden, and under reduced motion it draws one still frame.
 */
export function SidebarTide({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    let palette = readPalette(el);
    let width = 0;
    let height = 0;
    let raf = 0;
    let visible = true;
    let t = 0;
    let last = 0;

    function size() {
      const box = el!.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      el!.width = Math.round(width * dpr);
      el!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      let row = 0;
      for (let y = CELL / 2; y < height; y += CELL, row++) {
        for (let x = CELL / 2, col = 0; x < width; x += CELL, col++) {
          const surface =
            height * 0.3 +
            Math.sin(x * 0.034 + t * 0.21) * 7 +
            Math.sin(x * 0.071 - t * 0.14 + 1.3) * 3;
          const d = y - surface;
          // Solid below the surface (d > 0), shrinking to nothing above it.
          const r = d > 0 ? Math.min(CELL * 0.5, 1.2 + d * 0.09) : Math.max(0, CELL * 0.5 + d * 0.22);
          if (r < 0.35) continue;
          let color = palette.ink;
          let alpha = 0.16;
          if (Math.abs(d) < CELL * 0.6) {
            color = (col + row) % 5 === 0 ? palette.amber : palette.cobalt;
            alpha = 0.9;
          }
          ctx!.globalAlpha = alpha;
          ctx!.fillStyle = color;
          ctx!.beginPath();
          ctx!.arc(x, y, r, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      ctx!.globalAlpha = 1;
    }

    function frame(now: number) {
      t += Math.min((now - last) / 1000, 0.05) * 0.9;
      last = now;
      draw();
      raf = requestAnimationFrame(frame);
    }

    function schedule() {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden || reduced.matches) {
        draw();
        return;
      }
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    size();
    schedule();

    const observer = new ResizeObserver(() => {
      size();
      draw();
    });
    observer.observe(el);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", schedule);
    reduced.addEventListener("change", schedule);
    const unsubscribe = subscribeTheme(() => {
      palette = readPalette(el);
      draw();
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      reduced.removeEventListener("change", schedule);
      unsubscribe();
    };
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full", className)} />;
}
