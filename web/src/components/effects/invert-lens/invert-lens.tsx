"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { createMotionClock, observeTheme } from "./motion-clock";

export interface InvertLensProps {
  /** Live content to view through the lens, including images and interactive elements. */
  children?: ReactNode;
  /** Maximum square edge in pixels; constrained to the available space. */
  size?: number;
  /** Seconds for the horizontal leg of the autonomous Lissajous orbit. */
  period?: number;
  /** Tokens reflected into one another by an exact, per-channel sRGB matrix. */
  paperToken?: string;
  inkToken?: string;
  className?: string;
}

export function InvertLens({ children, size = 240, period = 20, paperToken = "--paper", inkToken = "--ink", className }: InvertLensProps) {
  const host = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const matrix = useRef<SVGFEColorMatrixElement>(null);
  const filterId = `invert-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    const element = host.current;
    const square = lens.current;
    if (!element || !square) return;
    let width = 0, height = 0, edge = 0;
    let x = 0, y = 0, initialized = false;
    const pointer = { x: 0, y: 0, active: false };
    const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const theme = () => {
      if (!pixel) return;
      const style = getComputedStyle(element);
      const rgb = (token: string) => {
        pixel.clearRect(0, 0, 1, 1);
        pixel.fillStyle = style.getPropertyValue(token).trim();
        pixel.fillRect(0, 0, 1, 1);
        return pixel.getImageData(0, 0, 1, 1).data;
      };
      const paper = rgb(paperToken), ink = rgb(inkToken);
      // Reflection around the midpoint of the two theme colors. Ordinary invert(1)
      // cannot exchange warm paper and ink exactly. SVG here defines a filter, not art.
      const sum = [0, 1, 2].map((i) => (paper[i] + ink[i]) / 255);
      matrix.current?.setAttribute("values", `-1 0 0 0 ${sum[0]} 0 -1 0 0 ${sum[1]} 0 0 -1 0 ${sum[2]} 0 0 0 1 0`);
    };
    const measure = () => {
      width = element.clientWidth; height = element.clientHeight;
      edge = Math.min(Math.max(40, size), width * 0.62, height * 0.72);
      square.style.width = `${edge}px`; square.style.height = `${edge}px`;
    };
    theme(); measure();
    const clock = createMotionClock(element, ({ time, delta, reduced }) => {
      const phase = time * Math.PI * 2 / Math.max(6, period);
      const tx = pointer.active && !reduced ? pointer.x - edge / 2 : (width - edge) * (0.5 + 0.42 * Math.sin(phase));
      const ty = pointer.active && !reduced ? pointer.y - edge / 2 : (height - edge) * (0.5 + 0.4 * Math.sin(phase * 1.5 + 0.8));
      const ease = initialized && !reduced ? 1 - Math.exp(-delta * 7) : 1;
      x += (Math.max(0, Math.min(width - edge, tx)) - x) * ease;
      y += (Math.max(0, Math.min(height - edge, ty)) - y) * ease;
      initialized = true;
      square.style.transform = `translate3d(${x}px,${y}px,0)`;
    });
    const resize = new ResizeObserver(() => { measure(); clock.redraw(); });
    resize.observe(element);
    const move = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top; pointer.active = true;
    };
    const leave = () => { pointer.active = false; };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("pointercancel", leave);
    element.addEventListener("pointerup", leave);
    const stopTheme = observeTheme(element, theme);
    return () => {
      clock.dispose(); resize.disconnect(); stopTheme();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("pointercancel", leave);
      element.removeEventListener("pointerup", leave);
    };
  }, [size, period, paperToken, inkToken]);

  return (
    <div ref={host} className={cn("relative isolate overflow-hidden bg-paper text-ink", className)}>
      {children}
      <svg aria-hidden="true" width="0" height="0" className="pointer-events-none absolute">
        <defs><filter id={filterId} colorInterpolationFilters="sRGB"><feColorMatrix ref={matrix} type="matrix" /></filter></defs>
      </svg>
      <div ref={lens} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-20 will-change-transform" style={{ width: size, height: size, backdropFilter: `url(#${filterId})`, WebkitBackdropFilter: `url(#${filterId})` }} />
    </div>
  );
}
