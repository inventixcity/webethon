import { useSyncExternalStore } from "react";

/*
 * Motion values for the kit. Keep these in step with the motion tokens in src/app/globals.css.
 * CSS uses the --duration-* and --ease-* tokens. JavaScript (the motion package, canvas, rAF) uses these.
 */

/** Durations in milliseconds. */
export const duration = {
  /** Small state changes: colour, press, focus. */
  fast: 150,
  /** Default for hover, reveal and panel changes. */
  base: 200,
  /** Large moves, such as the button wipe. */
  slow: 300,
} as const;

/** The same durations in seconds, which is what the motion package takes. */
export const durationSeconds = {
  fast: duration.fast / 1000,
  base: duration.base / 1000,
  slow: duration.slow / 1000,
} as const;

/** Cubic-bezier control points. */
export const easing = {
  /** Entrances and answers to the user. Starts quick and settles gently. */
  enter: [0.22, 1, 0.36, 1],
  /** Movement between two states. Slow at both ends. */
  move: [0.65, 0, 0.35, 1],
} as const;

/** The same easings as CSS strings, for `transition-timing-function` and inline styles. */
export const easingCss = {
  enter: `cubic-bezier(${easing.enter.join(", ")})`,
  move: `cubic-bezier(${easing.move.join(", ")})`,
} as const;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Server and first client render assume no preference, then the real value takes over on hydration. */
function serverReducedMotion() {
  return false;
}

/** True when the visitor has asked the system for less motion. Updates live if the setting changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
}

/**
 * A Motion transition that lands at once when reduced motion is on: duration and delay become 0.
 * Usage: `transition={motionTransition(reduced, { duration: durationSeconds.base, ease: easing.enter })}`.
 */
export function motionTransition<T extends { duration?: number; delay?: number }>(reduced: boolean, transition: T): T {
  return reduced ? { ...transition, duration: 0, delay: 0 } : transition;
}
