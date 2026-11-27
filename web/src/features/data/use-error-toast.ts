"use client";

import { useEffect } from "react";
import { useToast } from "@/components/feedback/toaster";
import { describeError } from "@/lib/errors";

/**
 * Toasts a transient load error. A fatal one is left to the caller, which renders the error page
 * (see fatalPageView).
 */
export function useLoadErrorToast(error: unknown) {
  const toast = useToast();
  useEffect(() => {
    if (error === undefined || error === null) return;
    const view = describeError(error, { context: "page" });
    if (view.kind === "toast") toast.error(view);
  }, [error, toast]);
}
