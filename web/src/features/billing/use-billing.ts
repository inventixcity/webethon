"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import type { ErrorView } from "@/lib/errors";
import { type BillingSummary, getBilling, listProducts, type Product } from "./client";
import { billingError } from "./errors";

/**
 * Loads the product list and the signed-in person's billing together. A fatal failure comes back as a page
 * view (the screen shows its error page); a transient one is toasted and the screen stays usable.
 */
export function useBilling() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, mine] = await Promise.all([listProducts(), getBilling()]);
      setProducts(list);
      setSummary(mine);
    } catch (failure) {
      const view = billingError(failure, "page");
      setError(view);
      if (view.kind === "toast") toast.error(view);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return { products, summary, error, loading, reload: load };
}
