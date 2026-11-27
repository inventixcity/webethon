import { CheckoutButton } from "@/components/billing/checkout-button";
import { Button } from "@/components/ui/button";
import { type BillingSummary, formatPrice, type Product } from "@/features/billing/client";
import type { ErrorView } from "@/lib/errors";

/** One card per product. Hairlines between cards come from a rule-coloured grid behind them. */
export function PricingGrid({
  products,
  summary,
  loading,
  error,
  onRetry,
}: {
  products: Product[] | null;
  summary: BillingSummary | null;
  loading: boolean;
  error: ErrorView | null;
  onRetry: () => void;
}) {
  if (loading && !products) {
    return <p role="status" className="font-mono text-xs uppercase tracking-[0.12em] text-ink-muted">Loading prices</p>;
  }
  if (error && !products) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-4 border border-vermilion-deep p-4">
        <p className="text-vermilion-deep">{error.message}</p>
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!products?.length) {
    return <p className="text-ink-soft">Nothing is for sale yet.</p>;
  }

  const owned = new Set(summary?.entitlements.filter((item) => item.active).map((item) => item.productId));
  return (
    <ul className="grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3" aria-label="Products">
      {products.map((product) => {
        const has = owned.has(product.id);
        const interval = product.mode === "subscription" ? "per month" : "one-time";
        return (
          <li key={product.id} className="flex min-w-0 flex-col gap-6 bg-paper-raised p-6">
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                {product.mode === "subscription" ? "Subscription" : "Pass"}
              </p>
              <h2 className="mt-3 break-words text-2xl font-medium tracking-[-0.02em]">{product.name}</h2>
              {product.description && <p className="mt-3 break-words text-sm text-ink-soft">{product.description}</p>}
            </div>
            <p className="mt-auto">
              <span className="text-4xl font-medium tracking-[-0.03em]">{formatPrice(product.priceCents, product.currency)}</span>{" "}
              <span className="font-mono text-xs uppercase text-ink-muted">{interval}</span>
            </p>
            {has ? (
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-ink">You have access</p>
            ) : (
              <CheckoutButton productId={product.id} label={product.mode === "subscription" ? "Subscribe" : "Buy now"} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
