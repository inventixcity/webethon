"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { AuthHeader } from "@/components/auth/auth-header";
import { Field, PasswordField } from "@/components/auth/field";
import { PasswordLock, type PasswordLockState } from "@/components/auth/password-lock";
import { StrengthMeter } from "@/components/auth/strength-meter";
import { SubmitButton } from "@/components/auth/submit-button";
import { api, ApiError } from "@/lib/api/client";

type Invite = { email: string; displayName: string };

const EXPIRED = "This invitation has expired or was already used. Ask your examiner for a new invite.";
const UNREACHABLE = "We couldn't reach the service. Check your connection and try again.";

export function InviteForm({ token, side }: { token: string; side?: ReactNode }) {
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    api<Invite>(`/auth/invites/${encodeURIComponent(token)}`)
      .then((data) => {
        if (live) {
          setInvite(data);
          setDisplayName(data.displayName);
        }
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setError(EXPIRED);
        } else if (cause instanceof ApiError && cause.status !== 0) {
          setError(cause.message);
        } else {
          setError(UNREACHABLE);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api("/auth/invites/accept", { body: { token, password, displayName } });
      router.replace("/app");
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.status === 404
            ? EXPIRED
            : cause.message
          : UNREACHABLE,
      );
    } finally {
      setPending(false);
    }
  }

  // The padlock spins while the account is activated, and otherwise follows the password as it is typed.
  const lockState: PasswordLockState = pending ? "pending" : "idle";

  return (
    <main className="flex min-h-screen flex-col bg-paper text-ink">
      <AuthHeader index="06" section="Invitation" />
      <div className="flex flex-1 flex-col lg:flex-row">
      <section className="mx-auto grid min-h-[calc(100vh-4rem)] w-full min-w-0 max-w-6xl flex-1 content-center gap-10 px-5 py-12 md:grid-cols-12 md:px-8">
        <div className="md:col-span-5">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Account access / 01</p>
          <h1 className="mt-5 text-[clamp(2.5rem,7vw,5.5rem)] leading-[0.94] font-semibold tracking-[-0.04em]">
            You’re invited.
          </h1>
          <p className="mt-6 max-w-sm text-base text-ink-soft">
            Set a password to activate your Invigil candidate account.
          </p>
          <div data-theme="dark" className="mt-10 size-32 overflow-hidden bg-vermilion md:size-40">
            <PasswordLock length={password.length} state={lockState} className="scale-[1.35]" />
          </div>
        </div>
        <div className="md:col-span-6 md:col-start-7">
          {loading ? (
            <p role="status" className="font-mono text-xs uppercase tracking-wider">
              Checking invitation…
            </p>
          ) : null}
          {error && (
            <p role="alert" className="border-l-2 border-vermilion pl-4 text-sm">
              {error}
            </p>
          )}
          {!loading && invite && (
            <form onSubmit={submit} className="flex flex-col gap-6">
              <p className="border-b border-rule pb-4 font-mono text-xs">INVITED AS&nbsp; {invite.email}</p>
              <Field
                label="Display name"
                autoComplete="name"
                required
                minLength={1}
                maxLength={120}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                aria-label="Display name"
              />
              <div>
                <PasswordField
                  label="Create password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-label="Create password"
                />
                <StrengthMeter password={password} className="mt-4" />
              </div>
              <SubmitButton pending={pending} pendingLabel="Activating" className="w-full">
                Activate account
              </SubmitButton>
            </form>
          )}
        </div>
      </section>
      {side ? <aside className="hidden border-l border-ink lg:block lg:w-[min(30vw,26rem)] lg:shrink-0">{side}</aside> : null}
      </div>
    </main>
  );
}
