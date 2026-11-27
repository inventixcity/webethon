import { describeError, type ErrorView } from "@/lib/errors";

/** An admin action's failure as a toast. Action failures never replace the screen. */
export function actionToast(cause: unknown): ErrorView {
  return { ...describeError(cause, { context: "action" }), kind: "toast" };
}

/**
 * The field a form's failure names, with its message. Null when the failure names none of `fields`,
 * so the caller shows a toast instead.
 */
export function namedFieldError<F extends string>(
  cause: unknown,
  fields: readonly F[],
): { field: F; message: string } | null {
  const view = describeError(cause, { context: "form", fields });
  if (view.kind !== "field" || view.field === undefined) return null;
  const field = fields.find((name) => name === view.field);
  return field === undefined ? null : { field, message: view.message };
}
