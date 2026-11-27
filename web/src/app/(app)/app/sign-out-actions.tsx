"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type SignOut = "signout" | "signout-all";

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

export function SignOutActions({ className }: { className?: string }) {
  const [pending, setPending] = useState<SignOut | null>(null);
  const [error, setError] = useState<string>();

  async function signOut(action: SignOut) {
    setPending(action);
    setError(undefined);
    try {
      await api(`/auth/${action}`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : GENERIC_MESSAGE);
      setPending(null);
      return;
    }
    // The API has cleared the cookie, so the sign-in page is the right next stop.
    window.location.assign("/login");
  }

  return (
    <div className={cn("grid gap-4", className)}>
      <div aria-live="polite" className="min-h-4 font-mono text-[11px] tracking-wide">
        {error && (
          <p className="flex items-center gap-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          loading={pending === "signout"}
          disabled={pending !== null}
          onClick={() => signOut("signout")}
        >
          {pending === "signout" ? "Signing out" : "Sign out"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          loading={pending === "signout-all"}
          disabled={pending !== null}
          onClick={() => signOut("signout-all")}
        >
          {pending === "signout-all" ? "Signing out everywhere" : "Sign out of every device"}
        </Button>
      </div>
    </div>
  );
}
