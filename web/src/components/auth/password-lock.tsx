"use client";

import type { AnimationItem } from "lottie-web";
import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme/theme";
import { cn } from "@/lib/utils";

export type PasswordLockState = "idle" | "pending" | "ok" | "wrong";

type PasswordLockProps = {
  /** Characters typed so far. The shackle travels further as the password grows. */
  length: number;
  /** Characters that take the shackle to its full travel. 12 for a password, 6 for an email code. */
  total?: number;
  /** "pending" spins the padlock on a loop while the server checks. */
  state?: PasswordLockState;
  className?: string;
};

const SRC = "/lottie/padlock.json";
/** The last frame of the shackle's cycle, where the lock is fully travelled. */
const LAST_FRAME = 165;

// The colours baked into /public/lottie, so the lock follows the theme tokens at runtime.
const BAKED_TOKENS: Record<string, string> = {
  "18,17,14": "--ink",
  "251,248,241": "--paper-raised",
  "210,58,28": "--vermilion",
};

function tokenRgb(host: Element, name: string): number[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = getComputedStyle(host).getPropertyValue(name).trim();
  const hex = ctx.fillStyle.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
}

/** Swaps the baked colours in a Lottie file for the current theme's tokens. */
function retheme(root: unknown, host: Element) {
  const palette = Object.fromEntries(Object.values(BAKED_TOKENS).map((token) => [token, tokenRgb(host, token)]));
  const swap = (colour: number[]) => {
    const token = BAKED_TOKENS[colour.slice(0, 3).map((v) => Math.round(v * 255)).join(",")];
    return token ? [...(palette[token] ?? colour), colour[3] ?? 1] : colour;
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const shape = node as Record<string, any>;
    if ((shape.ty === "fl" || shape.ty === "st") && shape.c && Array.isArray(shape.c.k)) {
      if (typeof shape.c.k[0] === "number") shape.c.k = swap(shape.c.k);
      else for (const frame of shape.c.k) if (Array.isArray(frame.s)) frame.s = swap(frame.s);
    }
    Object.values(shape).forEach(walk);
  };
  walk(root);
}

/**
 * The padlock from the sign-in masthead, driven by the password field. Each character moves the shackle
 * along its cycle, so the lock follows the typing. While the server checks, it spins on a loop. Under
 * reduced motion it jumps to each position and never spins.
 */
export function PasswordLock({ length, total = 12, state = "idle", className }: PasswordLockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const animation = useRef<AnimationItem | null>(null);
  const target = useRef(0);
  const spinning = useRef(false);
  const reduced = useRef(false);
  // Set by the load effect once the animation exists: moves the lock toward the target position.
  const settle = useRef<() => void>(() => {});

  // "ok" opens the lock fully; otherwise the shackle follows the characters typed.
  useEffect(() => {
    target.current = state === "ok" ? LAST_FRAME : Math.min(1, length / total) * LAST_FRAME;
    settle.current();
  }, [length, total, state]);

  useEffect(() => {
    const spin = state === "pending" && !reduced.current;
    if (spin === spinning.current) return;
    spinning.current = spin;
    const item = animation.current;
    if (!item) return;
    if (spin) {
      item.loop = true;
      item.goToAndPlay(0, true);
    } else {
      item.pause();
      settle.current();
    }
  }, [state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme changes the colours read inside.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const abort = new AbortController();
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let current = 0;
    let observer: IntersectionObserver | undefined;
    let item: AnimationItem | null = null;

    const step = () => {
      raf = 0;
      if (!item || spinning.current) return;
      const gap = target.current - current;
      current = Math.abs(gap) < 0.01 || reduced.current ? target.current : current + gap * 0.2;
      item.goToAndStop(current, true);
      if (current !== target.current) raf = requestAnimationFrame(step);
    };
    settle.current = () => {
      if (reduced.current) {
        if (item) {
          current = target.current;
          item.goToAndStop(current, true);
        }
      } else if (!raf) {
        raf = requestAnimationFrame(step);
      }
    };

    async function start(host: HTMLDivElement) {
      const [{ default: lottie }, data] = await Promise.all([
        import("lottie-web/build/player/lottie_light"),
        fetch(SRC, { signal: abort.signal }).then((res) => res.json()),
      ]);
      if (abort.signal.aborted) return;

      retheme(data, host);
      item = lottie.loadAnimation({
        container: host,
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData: data,
        rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
      });
      animation.current = item;

      item.addEventListener("DOMLoaded", () => {
        if (!item) return;
        if (!reduced.current) {
          observer = new IntersectionObserver(([entry]) => {
            if (!item) return;
            if (entry?.isIntersecting === false) item.pause();
            else if (spinning.current) item.play();
          });
          observer.observe(host);
        }
        settle.current();
      });
    }

    start(container).catch((error: unknown) => {
      if (!abort.signal.aborted) console.error(`Could not load ${SRC}`, error);
    });

    return () => {
      abort.abort();
      cancelAnimationFrame(raf);
      observer?.disconnect();
      item?.destroy();
      item = null;
      animation.current = null;
      settle.current = () => {};
      spinning.current = false;
    };
  }, [theme]);

  return <div ref={containerRef} aria-hidden="true" className={cn("size-full", className)} />;
}
