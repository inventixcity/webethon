"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type VelocityMarqueeProps = {
  text: string;
  /** Pixels a second when nothing's happening. */
  speed?: number;
  /** Runs the other way. */
  reverse?: boolean;
  className?: string;
};

/** A marquee that responds to you: scrolling speeds it up and leans the type, and you can drag it by hand. */
export function VelocityMarquee({ text, speed = 70, reverse = false, className }: VelocityMarqueeProps) {
  const host = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    const strip = track.current;
    if (!element || !strip) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let offset = 0;
    let lastScroll = window.scrollY;
    let push = 0;
    let lean = 0;
    let dragging = false;
    let dragX = 0;
    let visible = true;

    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const scrolled = window.scrollY - lastScroll;
      lastScroll = window.scrollY;
      push += (scrolled * 42 - push) * Math.min(1, dt * 7);
      const direction = reverse ? -1 : 1;
      const velocity = dragging ? 0 : (speed + Math.abs(push)) * direction * (push < -1 ? -1 : 1);
      offset -= velocity * dt;
      const half = strip.scrollWidth / 2;
      if (half > 0) offset = ((offset % half) + half) % half;
      lean += (Math.max(-14, Math.min(14, push * 0.03)) - lean) * Math.min(1, dt * 9);
      strip.style.transform = `translate3d(${-offset}px,0,0) skewX(${-lean}deg)`;
      raf = requestAnimationFrame(frame);
    };

    const onDown = (event: PointerEvent) => {
      dragging = true;
      dragX = event.clientX;
      element.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      offset -= event.clientX - dragX;
      dragX = event.clientX;
    };
    const onUp = () => {
      dragging = false;
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      cancelAnimationFrame(raf);
      if (visible && !reduced) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    });

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
    observer.observe(element);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
    };
  }, [speed, reverse]);

  return (
    <div
      ref={host}
      className={cn("cursor-grab touch-pan-y overflow-hidden whitespace-nowrap select-none active:cursor-grabbing", className)}
    >
      <p className="sr-only">{text}</p>
      <div ref={track} aria-hidden="true" className="inline-flex will-change-transform">
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index} className="flex items-center gap-[0.4em] pr-[0.4em]">
            {text}
            <span className="inline-block size-[0.3em] bg-vermilion" />
          </span>
        ))}
      </div>
    </div>
  );
}
