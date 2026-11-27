"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthHeader } from "@/components/auth/auth-header";
import { PasswordField, Field } from "@/components/auth/field";
import { StrengthMeter } from "@/components/auth/strength-meter";
import { SubmitButton } from "@/components/auth/submit-button";
import { api, ApiError } from "@/lib/api/client";

type Invite = { email: string; displayName: string };

export function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    api<Invite>(`/invites/${encodeURIComponent(token)}`)
      .then((data) => { if (live) { setInvite(data); setDisplayName(data.displayName); } })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof ApiError && cause.status !== 0
          ? "This invitation has expired or was already used. Ask your examiner for a new invite."
          : "We couldn't reach the service. Check your connection and try again.");
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api("/invites/accept", { body: { token, password, displayName } });
      router.replace("/app");
    } catch (cause) {
      setError(cause instanceof ApiError
        ? cause.status === 404 ? "This invitation has expired or was already used. Ask your examiner for a new invite." : cause.message
        : "We couldn't reach the service. Check your connection and try again.");
    } finally { setPending(false); }
  }

  return (
    <main className="min-h-screen bg-paper text-ink">
      <AuthHeader index="06" section="Invitation" />
      <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl content-center gap-10 px-5 py-12 md:grid-cols-12 md:px-8">
        <div className="md:col-span-5">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Account access / 01</p>
          <h1 className="mt-5 text-[clamp(2.5rem,7vw,5.5rem)] leading-[0.94] font-semibold tracking-[-0.04em]">You’re invited.</h1>
          <p className="mt-6 max-w-sm text-base text-ink-soft">Set a password to activate your Invigil candidate account.</p>
        </div>
        <div className="md:col-span-6 md:col-start-7">
          {loading ? <p role="status" className="font-mono text-xs uppercase tracking-wider">Checking invitation…</p> : null}
          {error && <p role="alert" className="border-l-2 border-vermilion pl-4 text-sm">{error}</p>}
          {!loading && invite && <form onSubmit={submit} className="flex flex-col gap-6">
            <p className="border-b border-rule pb-4 font-mono text-xs">INVITED AS&nbsp; {invite.email}</p>
            <Field label="Display name" autoComplete="name" required minLength={1} maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="Display name" />
            <div><PasswordField label="Create password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Create password" /><StrengthMeter password={password} className="mt-4" /></div>
            <SubmitButton pending={pending} pendingLabel="Activating" className="w-full">Activate account</SubmitButton>
          </form>}
        </div>
      </section>
    </main>
  );
}
