"use client";

import { type RefObject, useEffect, useRef } from "react";

/** Calls `frame` on every animation frame while `target` is on screen and the tab is showing. `dt` is in seconds. */
export function useFrame(target: RefObject<Element | null>, frame: (dt: number, time: number) => void, enabled = true) {
  const latest = useRef(frame);

  useEffect(() => {
    latest.current = frame;
  });

  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;

    let raf = 0;
    let visible = true;
    let last = 0;
    let time = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      time += dt;
      latest.current(dt, time);
      raf = requestAnimationFrame(tick);
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      if (!visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      schedule();
    });

    observer.observe(element);
    document.addEventListener("visibilitychange", schedule);
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [target, enabled]);
}
