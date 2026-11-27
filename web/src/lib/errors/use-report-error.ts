"use client";

import { useCallback } from "react";
import { useToast } from "@/components/feedback/toaster";
import { describeError, type DescribeOptions } from "./describe";
import type { ErrorView } from "./types";

/**
 * Returns `report(cause, options)`. It turns a failure into an ErrorView and shows a toast for
 * kind "toast". The caller renders kind "field" inline (use `view.field`) and kind "page" itself.
 * Every view is returned, so the caller can always act on the result.
 */
export function useReportError() {
  const toast = useToast();

  return useCallback(
    (cause: unknown, options?: DescribeOptions): ErrorView => {
      const view = describeError(cause, options);
      if (view.kind === "toast") toast.error(view);
      return view;
    },
    [toast],
  );
}
