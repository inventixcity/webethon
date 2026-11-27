"use client";

import { AccessSummary } from "@/components/billing/access-summary";
import { BillingNotice } from "@/components/billing/billing-notice";
import { PricingGrid } from "@/components/billing/pricing-grid";
import { ErrorPage } from "@/components/errors/error-page";
import { Button } from "@/components/ui/button";
import { useBilling } from "@/features/billing/use-billing";

/** The whole billing page below its heading. Reloads the summary when the person asks, e.g. after paying. */
export function BillingView({ status }: { status?: string }) {
  const { products, summary, error, loading, reload } = useBilling();

  // A fatal load error replaces the body with its error page, inside the billing page's layout.
  if (error?.kind === "page") {
    return (
      <ErrorPage
        code={error.page}
        requestId={error.requestId}
        retryAfterSeconds={error.retryAfterSeconds}
        onRetry={() => void reload()}
        as="div"
      />
    );
  }

  return (
    <div className="space-y-12">
      <BillingNotice status={status} />

      <section aria-labelledby="plans-heading" className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="plans-heading" className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">Plans</h2>
          {status === "success" && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
              Refresh access
            </Button>
          )}
        </div>
        <PricingGrid products={products} summary={summary} loading={loading} error={error} onRetry={() => void reload()} />
      </section>

      <section aria-labelledby="account-heading" className="space-y-6">
        <h2 id="account-heading" className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">Your account</h2>
        {loading && !summary ? (
          <p role="status" className="text-ink-soft">Loading your billing</p>
        ) : (
          <AccessSummary summary={summary} products={products} />
        )}
      </section>
    </div>
  );
}
