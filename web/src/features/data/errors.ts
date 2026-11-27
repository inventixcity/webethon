import { ApiError } from "@/lib/api/client";
import { describeError, type ErrorView } from "@/lib/errors";

/**
 * For a data view's page load. Returns the view when the screen must be replaced by an error page,
 * or null when the error is transient (the caller toasts it and the screen stays usable).
 */
export function fatalPageView(error: unknown): ErrorView | null {
  if (error === undefined || error === null) return null;
  const view = describeError(error, { context: "page" });
  return view.kind === "page" ? view : null;
}

/** The same view with a different message. Used where a screen needs wording the catalogue lacks. */
export function withMessage(view: ErrorView, message: string): ErrorView {
  return { ...view, message };
}

/** A storage or record limit, with the copy for this screen. */
export function limitView(view: ErrorView, noun: string): ErrorView {
  if (view.code !== "LIMIT_REACHED") return view;
  return withMessage(view, `You've reached the limit for ${noun}. Delete one to add another.`);
}

/**
 * Turns a failed save into what a form shows. Each field the server names gets its own message.
 * When no field is named, `toast` carries the error for a toast. Mutations always toast, so pass
 * `toast` on to useToast().error().
 */
export function formFailure(
  cause: unknown,
  fields: readonly string[],
): { named: Record<string, string>; toast: ErrorView | null } {
  const named: Record<string, string> = {};
  if (cause instanceof ApiError && cause.code === "VALIDATION_FAILED" && Array.isArray(cause.details)) {
    for (const detail of cause.details) {
      if (!isRecord(detail)) continue;
      // One detail at a time, so every field the server names keeps its own message.
      const single = new ApiError({
        code: "VALIDATION_FAILED",
        status: cause.status,
        message: typeof detail.message === "string" ? detail.message : "",
        details: [detail],
      });
      const view = describeError(single, { context: "form", fields });
      if (view.kind === "field" && view.field !== undefined && named[view.field] === undefined) {
        named[view.field] = view.message;
      }
    }
    if (Object.keys(named).length > 0) return { named, toast: null };
  }
  const view = describeError(cause, { context: "form", fields });
  if (view.kind === "field" && view.field !== undefined) return { named: { [view.field]: view.message }, toast: null };
  return { named, toast: view };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
