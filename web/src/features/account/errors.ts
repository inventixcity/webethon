import type { ToastApi, ToastOptions } from "@/components/feedback/toaster";
import { describeError, type ErrorView } from "@/lib/errors";

/** Kept so existing imports still compile. The copy comes from the shared catalogue, never from the server's raw text. */
export { messageFor, validationField } from "@/lib/errors";

/**
 * An action's failure (a button, a background request) as a toast. A fatal code would replace the whole
 * screen, and the screen should stay usable, so the view is always a toast.
 */
export function toastFor(cause: unknown, copy?: Partial<Pick<ErrorView, "title" | "message">>): ErrorView {
  return { ...describeError(cause, { context: "action" }), ...copy, kind: "toast" };
}

/**
 * A form's failure, shown where it belongs. A kind "field" error goes to `onField` with the field it names.
 * Anything else becomes a toast. `toastView` lets a feature word its own toast.
 */
export function showFormError<F extends string>(
  cause: unknown,
  fields: readonly F[],
  toast: ToastApi,
  onField: (field: F, message: string) => void,
  toastView: ErrorView = toastFor(cause),
  toastOptions?: ToastOptions,
): void {
  const view = describeError(cause, { context: "form", fields });
  const field = view.kind === "field" ? fields.find((name) => name === view.field) : undefined;
  if (field !== undefined) onField(field, view.message);
  else toast.error(toastView, toastOptions);
}

/**
 * A stale record (VERSION_CONFLICT) gets a toast with a Reload action, which loads the latest copy.
 * Every other failure gets no action.
 */
export function staleReloadOptions(cause: unknown): ToastOptions | undefined {
  if (describeError(cause).code !== "VERSION_CONFLICT") return undefined;
  return { action: { label: "Reload", onClick: () => window.location.reload() } };
}
