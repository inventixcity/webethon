import { describeError, type ErrorView } from "@/lib/errors";

/** A billing failure as the billing screens show it. NOT_CONFIGURED gets billing's own sentence. */
export function billingError(cause: unknown, context: "page" | "action"): ErrorView {
  const view = describeError(cause, { context });
  return view.code === "NOT_CONFIGURED" ? { ...view, message: "Billing isn't set up here yet." } : view;
}

/** A checkout or portal failure. Always a toast, so the billing screen stays usable. */
export function billingToast(cause: unknown): ErrorView {
  return { ...billingError(cause, "action"), kind: "toast" };
}
