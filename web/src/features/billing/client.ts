/**
 * The billing calls, through the same-origin /api/v1 proxy. Prices and access come from the server only:
 * the browser sends a product id and gets back a Stripe URL to visit.
 */
import { api, ApiError } from "@/lib/api/client";

export type ProductMode = "payment" | "subscription";

export type Product = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  mode: ProductMode;
};

export type Entitlement = {
  productId: string;
  status: string;
  /** Null for one-off purchases, which never expire. */
  currentPeriodEnd: string | null;
  /** The server's answer to "may this person use the product right now?". */
  active: boolean;
};

export type Purchase = {
  productId: string;
  amountCents: number;
  currency: string;
  createdAt: string;
};

export type BillingSummary = {
  entitlements: Entitlement[];
  purchases: Purchase[];
};

export const listProducts = () => api<Product[]>("/billing/products", { method: "GET" });

export const getBilling = () => api<BillingSummary>("/billing/me", { method: "GET" });

/** Returns the Stripe Checkout URL. A fresh key per click stops a double click creating two sessions. */
export async function startCheckout(productId: string): Promise<string> {
  const { url } = await api<{ url: string }>("/billing/checkout", {
    body: { productId },
    headers: { "idempotency-key": newKey() },
  });
  return url;
}

/** Returns the Stripe customer portal URL, for managing a subscription. */
export async function openPortal(): Promise<string> {
  const { url } = await api<{ url: string }>("/billing/portal", { method: "POST" });
  return url;
}

/** Only sends the browser to Stripe over https, whatever the API returned. */
export function isSafeRedirect(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Throws when the URL isn't a Stripe https link, so the caller shows the catalogue's "unexpected reply" toast. */
export function assertSafeRedirect(url: string): void {
  if (!isSafeRedirect(url)) throw new ApiError({ code: "BAD_RESPONSE", status: 0, message: "The billing page couldn't be opened." });
}

function newKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
