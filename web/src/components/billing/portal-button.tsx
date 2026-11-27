"use client";

import { useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { assertSafeRedirect, openPortal } from "@/features/billing/client";
import { billingToast } from "@/features/billing/errors";

/** Opens Stripe's customer portal, where people change plans, payment methods or cancel. A failure is a toast. */
export function PortalButton() {
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const open = async () => {
    setPending(true);
    try {
      const url = await openPortal();
      assertSafeRedirect(url);
      window.location.assign(url);
    } catch (failure) {
      toast.error(billingToast(failure));
      setPending(false);
    }
  };

  return (
    <div>
      <Button type="button" variant="secondary" onClick={() => void open()} loading={pending} disabled={pending}>
        {pending ? "Opening portal" : "Manage subscription"}
      </Button>
    </div>
  );
}
