import { describeError, type ErrorView } from "@/lib/errors";

export const ALLOWANCE_MESSAGE = "You've used today's AI allowance. It resets tomorrow.";

/** Codes that mean the daily allowance is used up. Retrying does not help, so they are never offered for retry. */
const ALLOWANCE_CODES: ReadonlySet<string> = new Set(["LIMIT_REACHED", "QUOTA_EXCEEDED"]);

/**
 * An AI failure as the assistant screens show it. The daily allowance gets its own sentence.
 */
export function aiErrorView(cause: unknown): ErrorView {
  const view = describeError(cause, { context: "action" });
  if (!ALLOWANCE_CODES.has(view.code)) return view;
  return { ...view, title: "Daily allowance used", message: ALLOWANCE_MESSAGE };
}

export function isAllowanceView(view: ErrorView): boolean {
  return ALLOWANCE_CODES.has(view.code);
}
