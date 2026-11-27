"use client";

import { useEffect, useRef } from "react";
import { subscribeTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";
import type { PaperPlane } from "./paper-plane";

/** Draws a PaperPlane. Follows the pointer, pauses off-screen, and redraws on input when motion is reduced. */
export function PaperPlaneCanvas({ plane, className }: { plane: PaperPlane; className?: string }) {
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
    let colours = { paper: "#fff", shade: "#ddd", shadow: "#bbb", ink: "#000", trail: "#000" };

    function readTheme() {
      if (!canvas) return;
      const style = getComputedStyle(canvas);
      const token = (name: string) => style.getPropertyValue(name).trim();
      colours = {
        paper: token("--paper-raised"),
        shade: token("--paper"),
        shadow: token("--paper-sunk"),
        ink: token("--ink"),
        trail: token("--ink"),
      };
      plane.dirty = true;
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
      plane.dirty = true;
    }

    function render(now: number) {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      const reduced = motion.matches;
      if (!reduced) time += dt;
      if (context && width > 0 && (!reduced || plane.dirty)) {
        plane.dirty = false;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);
        plane.draw(context, colours, { width, height, time, dt, reduced });
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
      plane.point((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
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
  }, [plane]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("block size-full", className)} />;
}
