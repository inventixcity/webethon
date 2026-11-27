"use client";

import { ErrorPage } from "./error-page";
import { readErrorDetails } from "./read-error";

/**
 * The error boundary for a route segment. A status-like error (an API status, a Retry-After) picks its
 * page; anything else is a 500. The message and digest are never rendered.
 */
export function SegmentError({ error, retry }: { error: unknown; retry: () => void }) {
  const details = readErrorDetails(error, 500);
  return (
    <ErrorPage
      code={details.code}
      requestId={details.requestId}
      retryAfterSeconds={details.retryAfterSeconds}
      onRetry={retry}
    />
  );
}
