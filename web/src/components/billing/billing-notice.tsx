/** Shown after Stripe sends the browser back. The access itself comes from the webhook, so it may lag a moment. */
export function BillingNotice({ status }: { status?: string }) {
  if (status === "success") {
    return (
      <p role="status" className="border border-ink bg-paper-raised p-4 text-sm">
        Thanks, your payment went through. Access appears here once Stripe confirms it, usually within a few seconds.
        If it isn't here yet, reload this page.
      </p>
    );
  }
  if (status === "cancelled") {
    return (
      <p role="status" className="border border-rule bg-paper-raised p-4 text-sm text-ink-soft">
        Checkout was cancelled. You haven't been charged.
      </p>
    );
  }
  return null;
}
