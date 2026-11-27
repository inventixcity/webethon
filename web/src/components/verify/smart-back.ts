"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * True when Back can return to the page the user came from. That is an app-router history entry (set by any
 * in-app navigation, including client-side links), or a same-origin referrer. A tab with no earlier history
 * always goes to the fallback instead.
 */
export function canReturnBack(): boolean {
  if (window.history.length <= 1) return false;
  const state = window.history.state as { __NA?: unknown } | null;
  if (state?.__NA === true) return true;
  try {
    return document.referrer !== "" && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** A Back action: router.back() when there is somewhere to return to, otherwise a push to the fallback. */
export function useSmartBack(fallback = "/") {
  const router = useRouter();
  return useCallback(() => {
    if (canReturnBack()) router.back();
    else router.push(fallback);
  }, [router, fallback]);
}
