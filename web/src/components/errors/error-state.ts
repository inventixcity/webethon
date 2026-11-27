"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ErrorPageCode } from "@/lib/errors/types";
import { ERROR_PAGE_COPY, type ErrorCopy, signInHref } from "./copy";

export type ErrorPageProps = {
  code: ErrorPageCode;
  /** The id to quote to support. Shown with a copy button; left out when there isn't one. */
  requestId?: string;
  /** For 429: seconds until the visitor may try again. Drives a live countdown. */
  retryAfterSeconds?: number;
  /** Re-renders the failed segment. Without it, "Try again" reloads the page. */
  onRetry?: () => void;
  /**
   * The root element. "main" for a full page; "div" when the page is rendered inside a screen that already
   * has a <main> landmark, so the document never has two.
   */
  as?: "main" | "div";
};

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Counts down from `total` seconds. Returns undefined when there is no countdown. */
function useCountdown(total: number | undefined) {
  const [remaining, setRemaining] = useState(total ?? 0);

  useEffect(() => {
    if (total === undefined || total <= 0) return;
    const endsAt = Date.now() + total * 1000;
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [total]);

  return total === undefined ? undefined : remaining;
}

export type ErrorPageState = {
  copy: ErrorCopy;
  /** The headline, with the live countdown filled in for 429. */
  headline: string;
  /** True while a 429 counts down, and while offline. Only the retry action is ever disabled. */
  disabled: boolean;
  /** Where the sign-in action links, with `next` set to the current page. */
  signInHref: string;
  /** Re-renders the segment, or reloads the page when there is no retry callback. */
  retry: () => void;
};

/**
 * Everything an error page does, separate from how it looks: the 429 countdown, the connection state, retry,
 * and the sign-in link that returns the visitor to this page.
 */
export function useErrorPageState({ code, retryAfterSeconds, onRetry }: ErrorPageProps): ErrorPageState {
  const copy = ERROR_PAGE_COPY[code];
  const pathname = usePathname();
  const countdown = useCountdown(code === 429 ? retryAfterSeconds : undefined);
  // Server render assumes online; the real value arrives after hydration, with no mismatch.
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  // Keep the latest callback for the connection listener, without re-subscribing on every render.
  const retryRef = useRef(onRetry);
  useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);

  const retry = () => {
    if (retryRef.current) retryRef.current();
    else window.location.reload();
  };

  // The offline page recovers by itself: as soon as the connection returns, it retries.
  useEffect(() => {
    if (code !== "offline") return;
    const recover = () => retry();
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
    // retry reads the callback from a ref, so it doesn't need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const waiting = countdown !== undefined && countdown > 0;
  const disabled = (code === 429 && waiting) || (code === "offline" && !online);
  const headline = typeof copy.headline === "function" ? copy.headline(code === 429 ? countdown : undefined) : copy.headline;

  return { copy, headline, disabled, signInHref: signInHref(pathname), retry };
}
