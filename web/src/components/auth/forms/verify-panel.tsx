"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CodeGrid } from "@/components/auth/code-lock";
import { Button } from "@/components/ui/button";
import { CODE_LENGTH, CODE_ERROR_ID, type useVerify } from "@/features/auth/use-verify";
import { CodeError } from "./code-error";

const linkStyle = "cursor-pointer underline underline-offset-4 hover:text-vermilion-deep disabled:text-ink-soft disabled:no-underline";

function RecoveryLink() {
  const params = useSearchParams();
  const mfa = params.get("mfa");
  if (!mfa) return null;
  const query = new URLSearchParams({ mfa });
  const next = params.get("next");
  if (next) query.set("next", next);
  return <Link href={`/recovery?${query}`} className={linkStyle}>Use a recovery code</Link>;
}

type VerifyPanelProps = {
  verify: ReturnType<typeof useVerify>;
  /** Hides the Continue button, for the password reset path that moves on by itself. */
  next?: string;
  className?: string;
};

/**
 * The six digit code entry: a full width row of cells, the same as the reset design. The row pulses while the code is
 * checked, cascades when it is right, and shakes when it is wrong.
 */
export function VerifyPanel({ verify, next, className }: VerifyPanelProps) {
  const { verified, routes } = verify;

  return (
    <div className={className}>
      <CodeGrid
        id="verify-code"
        label="Verification code"
        numeric
        length={CODE_LENGTH}
        value={verify.code}
        onChange={verify.change}
        onComplete={verify.complete}
        checking={verify.checking}
        verified={verified}
        shakeKey={verify.attempt}
        autoFocus
        disabled={verify.checking || verified || verify.locked > 0}
        invalid={Boolean(verify.codeError)}
        describedBy={verify.codeError ? CODE_ERROR_ID : undefined}
      />

      <div className="mt-5 min-h-14 font-mono text-[11px] tracking-[0.12em] uppercase">
        {verified && next !== "reset" ? (
          <Button asChild size="lg" className="w-full justify-between">
            <Link href={routes.login}>
              Continue
              <ArrowRight />
            </Link>
          </Button>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div aria-live="polite">
              {verify.codeError ? (
                <CodeError verify={verify} />
              ) : (
                <span className="text-ink-muted">{verify.checking ? "Checking" : "Paste works too"}</span>
              )}
            </div>
            <div className="flex items-center gap-6">
              {verify.wait > 0 ? (
                <span className="text-ink-muted tabular-nums">
                  Resend in 00:{String(verify.wait).padStart(2, "0")}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={verify.resend}
                  disabled={verify.busy}
                  loading={verify.sending}
                  className="text-[11px] overflow-visible"
                >
                  {verify.sending ? "Sending" : "Resend code"}
                </Button>
              )}
              <Link href={routes.signup} className={linkStyle}>
                Wrong email?
              </Link>
            </div>
          </div>
        )}
      </div>
      <div className="font-mono text-[11px] tracking-[0.12em] uppercase">
        <Suspense fallback={null}><RecoveryLink /></Suspense>
      </div>
    </div>
  );
}
