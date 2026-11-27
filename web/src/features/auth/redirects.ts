/** Where people go after signing in when the URL doesn't say otherwise. */
export const DEFAULT_DESTINATION = "/app";

/** Paths a `next` parameter must never point at: the API itself and the sign-in pages. */
const RESERVED_PATHS = ["/api", "/login", "/signup"];

/**
 * Returns `value` when it is a path on this same origin that is safe to navigate to, otherwise null.
 * Browser only: it compares against window.location.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  // Must be a single leading slash: "//host" is protocol-relative and "/\host" is treated as one by some browsers.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  // Control characters (tabs, newlines, NUL) can be stripped by URL parsers and change the target.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  // Resolve the path the way the browser will, so "/app/../login" and "/app/%2e%2e/login" are seen as "/login".
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const reserved = [url.pathname, decoded].some((candidate) =>
    RESERVED_PATHS.some((base) => candidate === base || candidate.startsWith(`${base}/`)),
  );
  return reserved ? null : `${url.pathname}${url.search}${url.hash}`;
}

/** The destination for a successful sign-in, from the current URL's `next` parameter. */
export function destinationAfterSignIn(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return safeNext(next) ?? DEFAULT_DESTINATION;
}
