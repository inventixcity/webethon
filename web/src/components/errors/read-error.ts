import { ERROR_PAGE_CODES, type ErrorPageCode } from "@/lib/errors/types";

const HTTP_PAGE_CODES: ReadonlySet<number> = new Set(
  ERROR_PAGE_CODES.filter((code): code is Extract<ErrorPageCode, number> => typeof code === "number"),
);

export type ErrorDetails = {
  /** The HTTP status when the error carries one. 0 means the request never got an answer. */
  status: number | undefined;
  /** The error page to show. */
  code: ErrorPageCode;
  requestId: string | undefined;
  retryAfterSeconds: number | undefined;
};

function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads the status-like fields an API error carries (status, requestId, retryAfter). It never reads
 * message, digest or stack, so none of them can reach the page.
 */
export function readErrorDetails(error: unknown, fallback: ErrorPageCode = 500): ErrorDetails {
  const rawStatus = field(error, "status");
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;

  const rawId = field(error, "requestId");
  const requestId = typeof rawId === "string" && rawId.length > 0 && rawId.length <= 128 ? rawId : undefined;

  const rawRetry = field(error, "retryAfter");
  const retryAfterSeconds =
    typeof rawRetry === "number" && Number.isFinite(rawRetry) && rawRetry >= 0 ? rawRetry : undefined;

  let code: ErrorPageCode = fallback;
  if (status === 0) code = 503;
  else if (status !== undefined && status >= 400 && HTTP_PAGE_CODES.has(status)) code = status as ErrorPageCode;

  return { status, code, requestId, retryAfterSeconds };
}
