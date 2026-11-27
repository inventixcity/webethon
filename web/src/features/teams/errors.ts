import { toastFor } from "@/features/account/errors";
import { describeError, type ErrorView } from "@/lib/errors";

/** The copy for a team name that another team already uses, shown on the name field. */
export const TAKEN_NAME_MESSAGE = "Another team already uses this name. Choose a different one.";

const FORBIDDEN_IN_TEAM = { message: "You can't do that in this team." };
const INVITE_GONE = { title: "Invite not available", message: "This invite has expired or was cancelled." };
const CHANGED = {
  title: "This has changed",
  message: "This changed while you were editing. Reload to see the latest.",
};

/**
 * The toast for a team action. Team wording replaces the generic copy where it reads better.
 * `scope: "invite"` is for invite actions, where NOT_FOUND means the invite has gone.
 */
export function teamToastFor(cause: unknown, scope: "team" | "invite" = "team"): ErrorView {
  const view = toastFor(cause);
  if (view.code === "NOT_FOUND" && scope === "invite") return { ...view, ...INVITE_GONE };
  if (view.code === "FORBIDDEN") return { ...view, ...FORBIDDEN_IN_TEAM };
  if (view.code === "VERSION_CONFLICT") return { ...view, ...CHANGED };
  return view;
}

/**
 * The API answers CONFLICT when a team name is already taken. On the name forms that is a field error.
 */
export function isTakenName(cause: unknown): boolean {
  return describeError(cause).code === "CONFLICT";
}
