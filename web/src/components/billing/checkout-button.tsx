"use client";

import { useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { assertSafeRedirect, startCheckout } from "@/features/billing/client";
import { billingToast } from "@/features/billing/errors";

/** Asks the API for a Checkout Session, then sends the browser to Stripe. A failure is a toast. */
export function CheckoutButton({ productId, label, className }: { productId: string; label: string; className?: string }) {
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const start = async () => {
    setPending(true);
    try {
      const url = await startCheckout(productId);
      assertSafeRedirect(url);
      window.location.assign(url);
    } catch (failure) {
      toast.error(billingToast(failure));
      setPending(false);
    }
  };

  return (
    <div className={className}>
      <Button type="button" onClick={() => void start()} loading={pending} disabled={pending} className="w-full">
        {pending ? "Opening checkout" : label}
      </Button>
    </div>
  );
}
