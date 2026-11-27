import { PortalButton } from "@/components/billing/portal-button";
import { type BillingSummary, formatDate, formatPrice, type Product } from "@/features/billing/client";

/** What the signed-in person has access to, and what they have paid for. */
export function AccessSummary({ summary, products }: { summary: BillingSummary | null; products: Product[] | null }) {
  if (!summary) return null;
  const nameOf = (productId: string) => products?.find((product) => product.id === productId)?.name ?? productId;
  const hasSubscription = summary.entitlements.some((item) => item.currentPeriodEnd !== null);

  return (
    <div className="grid gap-10 md:grid-cols-2">
      <section aria-labelledby="access-heading" className="min-w-0">
        <h2 id="access-heading" className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">Your access</h2>
        {summary.entitlements.length ? (
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {summary.entitlements.map((item) => (
              <li key={item.productId} className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 py-4">
                <span className="min-w-0 break-words font-medium">{nameOf(item.productId)}</span>
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-ink-soft">
                  {item.active ? "Active" : "Not active"}
                  {item.currentPeriodEnd && ` · renews or ends ${formatDate(item.currentPeriodEnd)}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-ink-soft">You don't have anything yet.</p>
        )}
        {hasSubscription && <div className="mt-6"><PortalButton /></div>}
      </section>

      <section aria-labelledby="payments-heading" className="min-w-0">
        <h2 id="payments-heading" className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">Payments</h2>
        {summary.purchases.length ? (
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {summary.purchases.map((purchase, index) => (
              <li key={index} className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 py-4">
                <span className="min-w-0 break-words font-medium">{nameOf(purchase.productId)}</span>
                <span className="font-mono text-xs text-ink-soft">
                  {formatPrice(purchase.amountCents, purchase.currency)} · {formatDate(purchase.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-ink-soft">No payments yet.</p>
        )}
      </section>
    </div>
  );
}
