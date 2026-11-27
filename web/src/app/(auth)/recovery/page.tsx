"use client";

import Link from "next/link";
import { useState } from "react";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { destinationAfterSignIn } from "@/features/auth/redirects";
import { api, ApiError } from "@/lib/api/client";

const RECOVERY_FIELDS = ["recoveryCode"] as const;

/** Spends one recovery code. A missing sign-in token means the sign-in has ended, so the error says to start again. */
async function recover(code: string) {
  const token = new URLSearchParams(window.location.search).get("mfa");
  if (!token) throw new ApiError({ code: "UNAUTHENTICATED", status: 401, message: "UNAUTHENTICATED" });
  await api("/auth/mfa/verify", { body: { mfaToken: token, recoveryCode: code } });
  window.location.assign(destinationAfterSignIn());
}

export default function RecoveryPage() {
  const [code, setCode] = useState("");
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked > 0) return;
    await run("recovery", () => recover(code), RECOVERY_FIELDS);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-5 py-12 text-ink">
      <div className="grid w-full max-w-md gap-8">
        <header className="grid gap-4">
          <p className="font-mono text-xs tracking-[0.14em] text-ink-muted uppercase">Account / Recovery</p>
          <h1 className="text-5xl leading-none font-medium tracking-[-0.03em]">Use a recovery code.</h1>
          <p className="text-ink-soft">Enter one of the codes you saved when you enabled two-step verification. Each code works once.</p>
        </header>
        <form onSubmit={submit} className="grid gap-5">
          <Field
            name="recoveryCode"
            label="Recovery code"
            placeholder="xxxx-xxxx-xxxx"
            autoComplete="one-time-code"
            required
            value={code}
            error={fieldErrors.recoveryCode}
            onChange={(event) => {
              setCode(event.target.value);
              clearFieldError("recoveryCode");
            }}
          />
          <SubmitButton pending={pending === "recovery"} disabled={locked > 0} pendingLabel="Checking…">Continue</SubmitButton>
        </form>
        <Link href="/login" className="font-mono text-xs tracking-[0.12em] text-ink-muted uppercase hover:text-vermilion-deep">Back to sign in</Link>
      </div>
    </main>
  );
}
