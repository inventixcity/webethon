/**
 * Shared error contract (owned by the frontend manager). Error pages and the error mapping both import from here.
 * Change it only with the lead's approval, because every form, hook and page depends on these names.
 */

/** Every full-page error the app can show. Each one has its own ASCII-shark scene. */
export const ERROR_PAGE_CODES = [
  400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 428, 429, 500, 502, 503, 504, "offline", "session-expired",
] as const;

export type ErrorPageCode = (typeof ERROR_PAGE_CODES)[number];

/**
 * How an error reaches the user:
 * - "field":  shown inline, next to the form field it is about (`ErrorView.field` names it).
 * - "toast":  transient or action-level; shown as a toast, the screen stays usable.
 * - "page":   fatal for the screen; the matching error page replaces it.
 */
export type ErrorKind = "field" | "toast" | "page";

/** What a caller renders. Never contains a raw code, JSON or a stack trace in `title` or `message`. */
export type ErrorView = {
  kind: ErrorKind;
  /** Short heading: the toast title, or the page headline when kind is "page". */
  title: string;
  /** One plain sentence for a person. */
  message: string;
  /** For kind "field": the form field path (as named by the form schema). */
  field?: string;
  /** The error page that would show this error. Always set, even when kind is not "page". */
  page: ErrorPageCode;
  /** Seconds from Retry-After, for RATE_LIMITED (drives the live countdown). */
  retryAfterSeconds?: number;
  /** The request id to quote to support. Shown with a copy button, never in the title or message. */
  requestId?: string;
  /** The API code (or a client code such as "UNAVAILABLE"). For tests and logs only, never rendered. */
  code: string;
};
