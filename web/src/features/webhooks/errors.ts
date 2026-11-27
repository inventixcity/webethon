import { ApiError } from "@/lib/api/client";
import { describeError, type ErrorView } from "@/lib/errors";
import { withMessage } from "@/features/data/errors";

/**
 * The toast for a failed webhook action. The per-user limit is the one case that shows the server's own
 * sentence, when it is short and plain. Everything else keeps the catalogue wording.
 */
export function webhookToast(cause: unknown): ErrorView {
  const view = describeError(cause, { context: "action" });
  if (cause instanceof ApiError && cause.code === "LIMIT_REACHED" && isPlainSentence(cause.message)) {
    return withMessage(view, cause.message.trim());
  }
  return view;
}

function isPlainSentence(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < 200 && !/[{}[\]]/.test(trimmed) && !trimmed.includes("Error:");
}
