"use client";

import type { AnimationItem } from "lottie-web";
import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";

export type LottieLoopProps = {
  /** Path to a Lottie JSON file in /public. */
  src: string;
  /** "loop" restarts at the end. "bounce" plays forward then back, for files whose ends don't match. */
  mode?: "loop" | "bounce";
  speed?: number;
  /** Progress from 0 to 1 to hold as a still frame under reduced motion. */
  stillAt?: number;
  className?: string;
};

// The colours baked into /public/lottie, so files follow the theme tokens at runtime.
const BAKED_TOKENS: Record<string, string> = {
  "18,17,14": "--ink",
  "251,248,241": "--paper-raised",
  "210,58,28": "--vermilion",
};

function resolveToken(host: Element, name: string): number[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = getComputedStyle(host).getPropertyValue(name).trim();
  const hex = ctx.fillStyle.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
}

function retheme(root: unknown, host: Element) {
  const palette = Object.fromEntries(Object.values(BAKED_TOKENS).map((t) => [t, resolveToken(host, t)]));

  const swap = (colour: number[]) => {
    const key = colour
      .slice(0, 3)
      .map((v) => Math.round(v * 255))
      .join(",");
    const token = BAKED_TOKENS[key];
    if (!token) return colour;
    return [...(palette[token] ?? colour), colour[3] ?? 1];
  };

  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const shape = node as Record<string, any>;
    if ((shape.ty === "fl" || shape.ty === "st") && shape.c) {
      const k = shape.c.k;
      if (Array.isArray(k) && typeof k[0] === "number") shape.c.k = swap(k);
      else if (Array.isArray(k)) {
        for (const frame of k) {
          if (Array.isArray(frame.s)) frame.s = swap(frame.s);
          if (Array.isArray(frame.e)) frame.e = swap(frame.e);
        }
      }
    }
    Object.values(shape).forEach(walk);
  };
  walk(root);
}

/**
 * Plays a Lottie file on a seamless loop, in the colours of the surface it sits on.
 * Uses the light player, which has no `eval`, pauses off-screen, and holds a still frame
 * under reduced motion.
 */
export function LottieLoop({ src, mode = "loop", speed = 1, stillAt = 0.5, className }: LottieLoopProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme changes the colours read inside.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const abort = new AbortController();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animation: AnimationItem | undefined;
    let observer: IntersectionObserver | undefined;

    async function start(host: HTMLDivElement) {
      const [{ default: lottie }, data] = await Promise.all([
        import("lottie-web/build/player/lottie_light"),
        fetch(src, { signal: abort.signal }).then((res) => res.json()),
      ]);
      if (abort.signal.aborted) return;

      retheme(data, host);

      const item = lottie.loadAnimation({
        container: host,
        renderer: "svg",
        loop: mode === "loop",
        autoplay: false,
        animationData: data,
        rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
      });
      animation = item;
      item.setSpeed(speed);

      item.addEventListener("DOMLoaded", () => {
        if (reduced) {
          item.goToAndStop(Math.round((item.totalFrames - 1) * stillAt), true);
          return;
        }
        observer = new IntersectionObserver(([entry]) => {
          if (entry?.isIntersecting) item.play();
          else item.pause();
        });
        observer.observe(host);
      });

      if (mode === "bounce") {
        let direction: 1 | -1 = 1;
        item.addEventListener("complete", () => {
          direction = direction === 1 ? -1 : 1;
          item.setDirection(direction);
          item.play();
        });
      }
    }

    start(container).catch((error: unknown) => {
      if (!abort.signal.aborted) console.error(`Could not load ${src}`, error);
    });

    return () => {
      abort.abort();
      observer?.disconnect();
      animation?.destroy();
    };
  }, [src, mode, speed, stillAt, theme]);

  return <div ref={containerRef} aria-hidden="true" className={cn("size-full", className)} />;
}
