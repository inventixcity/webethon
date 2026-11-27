"use client";

import { useReducedMotion } from "motion/react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useFrame } from "../use-frame";

const POOL = 14;
const IDLE_AFTER = 2200; // ms without the pointer before the trail starts drawing itself

export type ImageTrailProps = {
  /** The tiles to lay down: images, or anything else square. */
  items: readonly React.ReactNode[];
  /** Pixels the pointer travels between tiles. */
  spacing?: number;
  children?: React.ReactNode;
  className?: string;
};

/** Tiles land under the pointer and fade away, bigger the faster you move. Left alone, it draws its own path. */
export function ImageTrail({ items, spacing = 120, children, className }: ImageTrailProps) {
  const reduced = useReducedMotion() ?? false;
  const host = useRef<HTMLDivElement>(null);
  const tiles = useRef<(HTMLDivElement | null)[]>([]);
  const next = useRef(0);
  const layer = useRef(1);
  const lastDrop = useRef({ x: 0, y: 0, time: 0 });
  const touched = useRef(-Infinity);

  function drop(x: number, y: number, now: number) {
    const { x: lastX, y: lastY, time } = lastDrop.current;
    const distance = Math.hypot(x - lastX, y - lastY);
    if (distance < spacing) return;

    const speed = distance / Math.max(16, now - time);
    lastDrop.current = { x, y, time: now };

    const tile = tiles.current[next.current % POOL];
    next.current += 1;
    if (!tile) return;

    layer.current += 1;
    tile.style.left = `${x}px`;
    tile.style.top = `${y}px`;
    tile.style.zIndex = String(layer.current);
    const scale = 0.8 + Math.min(0.6, speed * 0.28);
    const tilt = (Math.random() - 0.5) * 14;
    const at = (lift: number, size: number, turn: number) =>
      `translate(-50%, calc(-50% + ${lift}px)) rotate(${turn}deg) scale(${size})`;

    tile.getAnimations().forEach((animation) => animation.cancel());
    tile.animate(
      reduced
        ? [
            { opacity: 1, transform: at(0, scale, 0) },
            { opacity: 1, transform: at(0, scale, 0), offset: 0.7 },
            { opacity: 0, transform: at(0, scale, 0) },
          ]
        : [
            { opacity: 0, transform: at(0, scale * 0.6, tilt * 2) },
            { opacity: 1, transform: at(0, scale, tilt), offset: 0.12 },
            { opacity: 1, transform: at(0, scale, tilt), offset: 0.55 },
            { opacity: 0, transform: at(44, scale * 0.84, tilt) },
          ],
      { duration: 1250, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" },
    );
  }

  useFrame(
    host,
    (_, time) => {
      const element = host.current;
      if (!element || performance.now() - touched.current < IDLE_AFTER) return;
      const { width, height } = element.getBoundingClientRect();
      const x = width / 2 + Math.sin(time * 0.8) * width * 0.38;
      const y = height / 2 + Math.sin(time * 1.3 + 1) * height * 0.32;
      drop(x, y, performance.now());
    },
    !reduced,
  );

  return (
    <div
      ref={host}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        touched.current = performance.now();
        drop(event.clientX - box.left, event.clientY - box.top, event.timeStamp);
      }}
      className={cn("relative isolate touch-pan-y overflow-hidden", className)}
    >
      {children}
      {Array.from({ length: POOL }, (_, index) => (
        <div
          key={index}
          ref={(element) => {
            tiles.current[index] = element;
          }}
          aria-hidden="true"
          className="pointer-events-none absolute opacity-0"
        >
          {items[index % items.length]}
        </div>
      ))}
    </div>
  );
}
