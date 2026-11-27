"use client";

import { useEffect, useMemo } from "react";
import { useToast } from "@/components/feedback/toaster";
import { describeError, type ErrorView } from "@/lib/errors";

/**
 * Describes the load error of a whole screen. A fatal error returns its view, so the screen can render the
 * error page for it. A transient error is also shown as a toast, and the screen keeps its inline retry.
 */
export function useScreenError(error: unknown): ErrorView | undefined {
  const toast = useToast();
  const view = useMemo(() => (error === undefined ? undefined : describeError(error, { context: "page" })), [error]);

  useEffect(() => {
    if (view?.kind === "toast") toast.error(view);
  }, [view, toast]);

  return view;
}
