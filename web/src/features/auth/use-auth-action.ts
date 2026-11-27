"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { describeError, type ErrorView } from "@/lib/errors";

/**
 * Runs one auth action and reports a failure the same way on every auth screen:
 * - kind "field": the error is kept in `fieldErrors` under the field it names, until that field changes.
 * - kind "toast": a toast shows it, and the form stays usable.
 * - RATE_LIMITED: the toast says how long to wait, and `locked` counts down. Submit stays disabled until 0.
 *
 * `run` resolves to the ErrorView on failure and to undefined on success.
 */
export function useAuthAction() {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [lockedUntil, setLockedUntil] = useState<number>();
  const locked = useSecondsLeft(lockedUntil);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, fields?: readonly string[]): Promise<ErrorView | undefined> => {
      setPending(key);
      setFieldErrors({});
      try {
        await action();
        return undefined;
      } catch (cause) {
        let view = describeError(cause, { context: "form", fields });
        if (view.retryAfterSeconds !== undefined && view.retryAfterSeconds > 0) {
          setLockedUntil(Date.now() + view.retryAfterSeconds * 1000);
          view = { ...view, message: `Try again in ${secondsText(view.retryAfterSeconds)}.` };
        }
        if (view.kind === "field" && view.field !== undefined) {
          setFieldErrors({ [view.field]: view.message });
        } else if (view.kind === "toast") {
          toast.error(view);
        }
        return view;
      } finally {
        setPending(null);
      }
    },
    [toast],
  );

  /** Call from a field's change handler, so its error goes as soon as the person edits it. */
  const clearFieldError = useCallback((field: string) => {
    setFieldErrors((current) => (current[field] === undefined ? current : { ...current, [field]: undefined }));
  }, []);

  return { pending, locked, fieldErrors, clearFieldError, run };
}

/** Whole seconds left until `until` (a timestamp), or 0. Ticks while it counts down. */
function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [until]);

  if (until === undefined || until <= now) return 0;
  return Math.ceil((until - now) / 1000);
}

function secondsText(seconds: number): string {
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}
