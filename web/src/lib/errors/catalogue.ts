import type { ErrorPageCode } from "./types";

/**
 * Plain-language copy for every error the app can show. Written for a person:
 * no code names, no HTTP numbers, no jargon. The server's own text is never shown
 * for a code listed here, and never for an unknown code.
 */
export type CatalogueEntry = {
  /** Short heading for a toast, or the page headline. */
  title: string;
  /** One plain sentence. */
  message: string;
};

/** Every ErrorCode the API can send (crates/kernel/src/error.rs). */
export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "INVALID_CODE",
  "EMAIL_NOT_VERIFIED",
  "MFA_REQUIRED",
  "FORBIDDEN",
  "ACCOUNT_SUSPENDED",
  "CSRF_REJECTED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "VERSION_CONFLICT",
  "PRECONDITION_REQUIRED",
  "IDEMPOTENCY_MISMATCH",
  "WEAK_PASSWORD",
  "LIMIT_REACHED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "NOT_CONFIGURED",
  "UNAVAILABLE",
  "INTERNAL",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(API_ERROR_CODES);

/** Client-side codes from lib/api/client.ts that are not in the API list. */
export type ClientErrorCode = "BAD_RESPONSE" | "offline";

/** Keys for the HTTP status fallbacks, one per page code: HTTP_400 ... HTTP_504. */
export type HttpCatalogueKey = `HTTP_${Extract<ErrorPageCode, number>}`;

export type CatalogueKey = ApiErrorCode | ClientErrorCode | HttpCatalogueKey;

/** Used for anything the catalogue does not know. */
export const GENERIC_ENTRY: CatalogueEntry = {
  title: "Something went wrong",
  message: "Something went wrong on our side. Try again in a moment.",
};

export const CATALOGUE: Readonly<Record<CatalogueKey, CatalogueEntry>> = {
  // API codes
  BAD_REQUEST: {
    title: "That didn't go through",
    message: "Something in the request wasn't right. Refresh the page and try again.",
  },
  VALIDATION_FAILED: {
    title: "Check the details",
    message: "Some of the details aren't quite right. Fix them and try again.",
  },
  UNAUTHENTICATED: {
    title: "Sign in to continue",
    message: "Your session has ended, or you haven't signed in yet.",
  },
  INVALID_CREDENTIALS: {
    title: "Sign-in didn't work",
    message: "That email and password don't match. Check them and try again.",
  },
  INVALID_CODE: {
    title: "That code didn't work",
    message: "The code is wrong, already used, or expired. Ask for a new one and try again.",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Verify your email first",
    message: "Check your inbox for a code to finish signing in.",
  },
  MFA_REQUIRED: {
    title: "One more step",
    message: "Enter your verification code to finish signing in.",
  },
  FORBIDDEN: {
    title: "Not allowed",
    message: "You don't have access to that.",
  },
  ACCOUNT_SUSPENDED: {
    title: "Account suspended",
    message: "This account has been suspended. Contact support if you think that's a mistake.",
  },
  CSRF_REJECTED: {
    title: "Request blocked",
    message: "We stopped that request to keep your account safe. Reload the page and try again.",
  },
  NOT_FOUND: {
    title: "We couldn't find that",
    message: "It may have been deleted, or it isn't available to you.",
  },
  METHOD_NOT_ALLOWED: {
    title: "Not possible here",
    message: "That action isn't available on this page.",
  },
  CONFLICT: {
    title: "Already taken",
    message: "That already exists, or the same request is still being processed.",
  },
  VERSION_CONFLICT: {
    title: "This has changed",
    message: "Someone else changed it while you were editing. Reload to see the latest version.",
  },
  PRECONDITION_REQUIRED: {
    title: "Confirm your identity",
    message: "Confirm your password to continue.",
  },
  IDEMPOTENCY_MISMATCH: {
    title: "Request already used",
    message: "This request was sent before with different details. Start it again.",
  },
  WEAK_PASSWORD: {
    title: "Password too easy to guess",
    message: "That password is too easy to guess. Try a longer one.",
  },
  LIMIT_REACHED: {
    title: "Limit reached",
    message: "You've reached the limit for this. Remove something first, or try again later.",
  },
  PAYLOAD_TOO_LARGE: {
    title: "That's too large",
    message: "Make it smaller and try again.",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    title: "Can't use that file",
    message: "That kind of file isn't supported. Try a different one.",
  },
  RATE_LIMITED: {
    title: "Too many tries",
    message: "Wait a moment and try again.",
  },
  NOT_CONFIGURED: {
    title: "Not ready yet",
    message: "This feature isn't set up yet. Try again later.",
  },
  UNAVAILABLE: {
    title: "Can't reach the service",
    message: "We can't reach the service right now. Try again in a moment.",
  },
  INTERNAL: GENERIC_ENTRY,

  // Client codes
  BAD_RESPONSE: {
    title: "Unexpected reply",
    message: "We got a reply we didn't expect. Try again in a moment.",
  },
  offline: {
    title: "You're offline",
    message: "Check your internet connection, then try again.",
  },

  // Status fallbacks, for failures with no readable error body (for example from the proxy)
  HTTP_400: {
    title: "That didn't go through",
    message: "Something in the request wasn't right. Try again.",
  },
  HTTP_401: {
    title: "Sign in to continue",
    message: "Your session has ended, or you haven't signed in yet.",
  },
  HTTP_403: {
    title: "Not allowed",
    message: "You don't have access to that.",
  },
  HTTP_404: {
    title: "We couldn't find that",
    message: "It may have been deleted, or it isn't available to you.",
  },
  HTTP_405: {
    title: "Not possible here",
    message: "That action isn't available on this page.",
  },
  HTTP_408: {
    title: "That took too long",
    message: "The request timed out. Try again.",
  },
  HTTP_409: {
    title: "Already changed",
    message: "That clashes with a change that's already been made. Reload and try again.",
  },
  HTTP_410: {
    title: "No longer here",
    message: "That has been removed.",
  },
  HTTP_413: {
    title: "That's too large",
    message: "Make it smaller and try again.",
  },
  HTTP_415: {
    title: "Can't use that",
    message: "That kind of content isn't supported.",
  },
  HTTP_422: {
    title: "Can't save that",
    message: "Some of it doesn't meet the rules. Check it and try again.",
  },
  HTTP_428: {
    title: "Reload to continue",
    message: "Reload the page and try again.",
  },
  HTTP_429: {
    title: "Too many tries",
    message: "Wait a moment and try again.",
  },
  HTTP_500: GENERIC_ENTRY,
  HTTP_502: {
    title: "Can't reach the service",
    message: "We couldn't reach the service right now. Try again in a moment.",
  },
  HTTP_503: {
    title: "Can't reach the service",
    message: "We can't reach the service right now. Try again in a moment.",
  },
  HTTP_504: {
    title: "Taking too long",
    message: "The service took too long to answer. Try again in a moment.",
  },
};

/** The catalogue entry for a code, or undefined when the code is not in the catalogue. */
export function lookupEntry(code: string): CatalogueEntry | undefined {
  if (code === "offline" || !Object.hasOwn(CATALOGUE, code)) return undefined;
  return CATALOGUE[code as CatalogueKey];
}
