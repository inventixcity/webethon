import type { ErrorPageCode } from "@/lib/errors/types";

/** What the primary button does. "retry" re-renders the segment, or reloads the page when there is no retry callback. */
export type ErrorAction = {
  kind: "home" | "signin" | "back" | "retry";
  label: string;
};

export type ErrorCopy = {
  /** Small mono label: an eyebrow, then " / " and the code where there is one, e.g. "Error / 400". */
  label: string;
  /** Plain headline. The 429 headline takes the live countdown, in seconds. */
  headline: string | ((seconds: number | undefined) => string);
  /** One sentence: what happened and what to do. */
  body: string;
  action: ErrorAction;
};

export const ERROR_PAGE_COPY: Record<ErrorPageCode, ErrorCopy> = {
  400: {
    label: "Error / 400",
    headline: "That request didn't make sense.",
    body: "Something in what was sent wasn't right. Go back, check it, and try again.",
    action: { kind: "back", label: "Go back" },
  },
  401: {
    label: "Error / 401",
    headline: "You need to sign in.",
    body: "This page is for signed-in people. Sign in and you'll come straight back here.",
    action: { kind: "signin", label: "Sign in" },
  },
  403: {
    label: "Error / 403",
    headline: "You don't have access to this.",
    body: "If you think you should, ask the person who manages this workspace for access.",
    action: { kind: "home", label: "Back to home" },
  },
  404: {
    label: "Uncharted waters / 404",
    headline: "This page has been eaten.",
    body: "There was something here. The sharks got to it first. Let's get you back to dry land.",
    action: { kind: "home", label: "Back to dry land" },
  },
  405: {
    label: "Error / 405",
    headline: "That action isn't available here.",
    body: "This page doesn't take that kind of request. Go back and try another way.",
    action: { kind: "back", label: "Go back" },
  },
  408: {
    label: "Error / 408",
    headline: "That took too long.",
    body: "The connection stalled before it finished. Try again when you're ready.",
    action: { kind: "retry", label: "Try again" },
  },
  409: {
    label: "Error / 409",
    headline: "Someone changed this while you were looking. Reload to see the latest.",
    body: "Reloading shows the newest version, so you can make your changes again.",
    action: { kind: "retry", label: "Reload" },
  },
  410: {
    label: "Error / 410",
    headline: "This link is gone.",
    body: "It may have been unshared or removed. Ask the person who sent it for a new link.",
    action: { kind: "home", label: "Back to home" },
  },
  413: {
    label: "Error / 413",
    headline: "That's too big to send.",
    body: "Try a smaller file or fewer items, then go back and send it again.",
    action: { kind: "back", label: "Go back" },
  },
  415: {
    label: "Error / 415",
    headline: "That file type isn't supported.",
    body: "Choose a format we accept, then try again.",
    action: { kind: "back", label: "Go back" },
  },
  422: {
    label: "Error / 422",
    headline: "Some of this can't be saved as entered.",
    body: "Check the details that look wrong, then try again.",
    action: { kind: "back", label: "Go back" },
  },
  428: {
    label: "Error / 428",
    headline: "Reload before you save so you don't overwrite newer changes.",
    body: "Reload to get the latest version, then add your edits again.",
    action: { kind: "retry", label: "Reload" },
  },
  429: {
    label: "Error / 429",
    headline: (seconds) => {
      if (seconds === undefined) return "Too many requests. Try again shortly.";
      if (seconds <= 0) return "Too many requests. You can try again now.";
      return `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    },
    body: "You've sent a lot of requests in a short time. Wait for the countdown, then try again.",
    action: { kind: "retry", label: "Try again" },
  },
  500: {
    label: "Error / 500",
    headline: "Something broke on our side.",
    body: "Try again in a moment. If it keeps happening, let support know.",
    action: { kind: "retry", label: "Try again" },
  },
  502: {
    label: "Error / 502",
    headline: "We're having trouble reaching the service.",
    body: "Try again soon. If it keeps happening, let support know.",
    action: { kind: "retry", label: "Try again" },
  },
  503: {
    label: "Error / 503",
    headline: "We're having trouble reaching the service.",
    body: "Try again soon. If it keeps happening, let support know.",
    action: { kind: "retry", label: "Try again" },
  },
  504: {
    label: "Error / 504",
    headline: "We're having trouble reaching the service.",
    body: "Try again soon. If it keeps happening, let support know.",
    action: { kind: "retry", label: "Try again" },
  },
  offline: {
    label: "Connection",
    headline: "You're offline.",
    body: "Check your connection. This page will reconnect by itself when it's back.",
    action: { kind: "retry", label: "Try again" },
  },
  "session-expired": {
    label: "Session",
    headline: "Your session ended.",
    body: "Sign in again to continue.",
    action: { kind: "signin", label: "Sign in" },
  },
};

/**
 * Keeps a return path on this site. Anything that could leave the origin, or that would loop back to
 * sign-in, falls back to home.
 */
export function safeNextPath(path: string | null | undefined): string {
  if (!path || !path.startsWith("/")) return "/";
  if (path.startsWith("//") || path.startsWith("/\\") || /[\u0000-\u001f\\]/.test(path)) return "/";
  if (path === "/login" || path.startsWith("/login/") || path.startsWith("/login?")) return "/";
  return path;
}

/** The sign-in link for an error page, returning the visitor to `path` afterwards. */
export function signInHref(path: string | null | undefined): string {
  return `/login?next=${encodeURIComponent(safeNextPath(path))}`;
}
