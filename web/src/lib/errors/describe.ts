import { ApiError } from "../api/client";
import { API_ERROR_CODE_SET, CATALOGUE, GENERIC_ENTRY, lookupEntry, type CatalogueEntry } from "./catalogue";
import { ERROR_PAGE_CODES, type ErrorPageCode, type ErrorView } from "./types";

/**
 * Where the error is shown:
 * - "form":   a field-bound error goes inline next to its field; everything else is a toast.
 * - "action": a button or background request; a toast, unless the code is fatal.
 * - "page":   the screen is loading; a fatal code replaces it with an error page.
 */
export type ErrorContext = "form" | "action" | "page";

export type DescribeOptions = {
  /** Defaults to "action". */
  context?: ErrorContext;
  /** The form's field names. Needed to place a field-bound error. */
  fields?: readonly string[];
};

const NUMERIC_PAGES: ReadonlySet<number> = new Set(
  ERROR_PAGE_CODES.filter((code): code is Extract<ErrorPageCode, number> => typeof code === "number"),
);

/** API codes that replace the whole screen. Other API codes are toasts or inline field errors. */
const FATAL_PAGES: ReadonlyMap<string, ErrorPageCode> = new Map<string, ErrorPageCode>([
  ["NOT_FOUND", 404],
  ["UNAUTHENTICATED", 401],
  ["FORBIDDEN", 403],
  ["ACCOUNT_SUSPENDED", 403],
  ["CSRF_REJECTED", 403],
  ["METHOD_NOT_ALLOWED", 405],
  ["CONFLICT", 409],
  ["VERSION_CONFLICT", 409],
  ["PRECONDITION_REQUIRED", 428],
  ["PAYLOAD_TOO_LARGE", 413],
  ["UNSUPPORTED_MEDIA_TYPE", 415],
  ["RATE_LIMITED", 429],
  ["INTERNAL", 500],
  ["NOT_CONFIGURED", 503],
]);

/**
 * For codes the catalogue does not know (HTTP_* fallbacks, unknown codes): these statuses are fatal.
 * Every status of 500 and above is fatal too.
 */
const FATAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405, 409, 413, 415, 428, 429]);

/** Flow states, not errors. The caller redirects; the message is only a short notice. */
const FLOW_CODES: ReadonlySet<string> = new Set(["MFA_REQUIRED", "EMAIL_NOT_VERIFIED"]);

/**
 * Turns any thrown value into what the UI should show. Never throws.
 *
 * - Only ApiError carries a code. Anything else becomes the generic internal message.
 * - Raw server text is shown only for VALIDATION_FAILED, and only when it passes a safety check.
 * - `page` is always set. A code without a page maps to its HTTP status, or 500 when that has no page.
 */
export function describeError(cause: unknown, options?: DescribeOptions): ErrorView {
  const context: ErrorContext = options?.context ?? "action";
  try {
    if (!(cause instanceof ApiError)) return unexpectedView(context);
    return apiErrorView(cause, context, options?.fields);
  } catch {
    return unexpectedView(context);
  }
}

/** Plain text for any failure. Kept for existing callers; new code should use describeError. */
export function messageFor(cause: unknown): string {
  return describeError(cause, { context: "action" }).message;
}

/**
 * Which form field a VALIDATION_FAILED error is about. Returns undefined when the error is not a
 * validation error or does not name one of `fields`.
 */
export function validationField<F extends string>(cause: unknown, fields: readonly F[]): F | undefined {
  if (!(cause instanceof ApiError) || cause.code !== "VALIDATION_FAILED") return undefined;
  return matchValidationField(cause.details, fields);
}

function apiErrorView(error: ApiError, context: ErrorContext, fields: readonly string[] | undefined): ErrorView {
  const { code, status } = error;
  const offline = code === "UNAVAILABLE" && status === 0 && isOffline();

  const entry: CatalogueEntry = (offline ? CATALOGUE.offline : lookupEntry(code)) ?? GENERIC_ENTRY;
  const page = pageFor(code, status, offline);
  const field = context === "form" ? fieldFor(code, error.details, fields) : undefined;

  let kind: ErrorView["kind"];
  if (FLOW_CODES.has(code)) kind = "toast";
  else if (context === "form") kind = field !== undefined ? "field" : "toast";
  else kind = isFatal(code, status) ? "page" : "toast";

  const view: ErrorView = { kind, title: entry.title, message: messageText(code, error, entry), page, code };
  if (kind === "field" && field !== undefined) view.field = field;
  if (typeof error.requestId === "string" && error.requestId !== "") view.requestId = error.requestId;
  if (typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter)) {
    view.retryAfterSeconds = error.retryAfter;
  }
  return view;
}

function messageText(code: string, error: ApiError, entry: CatalogueEntry): string {
  if (code === "VALIDATION_FAILED" && isShowableServerMessage(error.message)) return error.message.trim();
  if (code === "RATE_LIMITED" && typeof error.retryAfter === "number" && error.retryAfter > 0) {
    return `Wait ${waitText(error.retryAfter)} and try again.`;
  }
  return entry.message;
}

function pageFor(code: string, status: number, offline: boolean): ErrorPageCode {
  if (code === "UNAVAILABLE") {
    if (status === 504) return 504;
    return offline ? "offline" : 503;
  }
  if (code === "BAD_RESPONSE") return 500;
  const fatal = FATAL_PAGES.get(code);
  if (fatal !== undefined) return fatal;
  return pageFromStatus(status);
}

function isFatal(code: string, status: number): boolean {
  if (code === "UNAVAILABLE" || code === "BAD_RESPONSE") return true;
  if (API_ERROR_CODE_SET.has(code)) return FATAL_PAGES.has(code);
  return status >= 500 || FATAL_STATUSES.has(status);
}

/** Field-bound codes. Only used in the "form" context. */
function fieldFor(code: string, details: unknown, fields: readonly string[] | undefined): string | undefined {
  switch (code) {
    case "VALIDATION_FAILED":
      return fields === undefined ? undefined : matchValidationField(details, fields);
    case "WEAK_PASSWORD":
      return "password";
    case "INVALID_CREDENTIALS":
      return preferField(fields, "password");
    case "INVALID_CODE":
      return preferField(fields, "code");
    default:
      return undefined;
  }
}

function preferField(fields: readonly string[] | undefined, preferred: string): string | undefined {
  if (fields === undefined || fields.length === 0) return undefined;
  return fields.includes(preferred) ? preferred : fields[0];
}

/**
 * Reads the field path from `details`. The API sends `[{ path, message }]` with paths relative to the
 * body's data object ("tags.2"). `{ path: "/title" }` and `{ field }` are accepted too, and so is
 * `{ "title": "message" }`. Each path matches a field by its exact name, then by its first segment.
 */
function matchValidationField<F extends string>(details: unknown, fields: readonly F[]): F | undefined {
  if (fields.length === 0) return undefined;
  for (const path of validationPaths(details)) {
    const field = matchPath(path, fields);
    if (field !== undefined) return field;
  }
  return undefined;
}

function validationPaths(details: unknown): string[] {
  if (Array.isArray(details)) {
    const paths: string[] = [];
    for (const item of details) {
      if (!isRecord(item)) continue;
      const path = item.path ?? item.field;
      if (typeof path === "string") paths.push(path);
    }
    return paths;
  }
  return isRecord(details) ? Object.keys(details) : [];
}

function matchPath<F extends string>(path: string, fields: readonly F[]): F | undefined {
  const name = path.replace(/^\/+/, "").replace(/\//g, ".");
  const first = name.split(".")[0];
  return fields.find((field) => field === name) ?? fields.find((field) => field === first);
}

/**
 * The server's validation message is shown only when it is short, non-empty and free of internals:
 * no braces or brackets, no "Error:", and no stack-trace line.
 */
function isShowableServerMessage(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length < 200 &&
    !/[{}[\]]/.test(trimmed) &&
    !trimmed.includes("Error:") &&
    !/^\s*at /m.test(trimmed)
  );
}

function unexpectedView(context: ErrorContext): ErrorView {
  return {
    kind: context === "page" ? "page" : "toast",
    title: GENERIC_ENTRY.title,
    message: GENERIC_ENTRY.message,
    page: 500,
    code: "INTERNAL",
  };
}

function pageFromStatus(status: number): ErrorPageCode {
  return NUMERIC_PAGES.has(status) ? (status as ErrorPageCode) : 500;
}

function waitText(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
