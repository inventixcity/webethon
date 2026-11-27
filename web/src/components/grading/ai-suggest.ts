"use client";

import { useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { GradingSuggestion } from "@/lib/exam/types";

/*
 * The optional AI grading assistant. Advisory only: a suggestion never saves a mark. The examiner decides.
 *
 * If the assistant is missing (404) or not configured (NOT_CONFIGURED), the button is hidden for the rest of
 * this browser session. The flag lives in memory, so a reload asks again.
 */

let unavailable = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function markUnavailable() {
  if (unavailable) return;
  unavailable = true;
  for (const listener of listeners) listener();
}

/** True until the assistant has reported itself missing or unconfigured in this session. */
export function useSuggestAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !unavailable,
    () => true,
  );
}

export function isUnavailableError(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.code === "NOT_CONFIGURED");
}

/**
 * Asks for a suggestion for one written answer. Throws ApiError on failure. When the assistant is unavailable,
 * the button is hidden for the session before the error reaches the caller, which should check `isUnavailableError`.
 */
export async function requestSuggestion(attemptId: string, itemId: string): Promise<GradingSuggestion> {
  try {
    return await api<GradingSuggestion>(`/attempts/${attemptId}/answers/${itemId}/suggest`, { method: "POST" });
  } catch (cause) {
    if (isUnavailableError(cause)) markUnavailable();
    throw cause;
  }
}
