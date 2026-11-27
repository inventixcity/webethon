"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPSlot } from "@/components/ui/input-otp";
import { CODE_LENGTH, type useVerify } from "@/features/auth/use-verify";
import { cn } from "@/lib/utils";
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
  /** Extra classes for each digit cell. */
  cellClassName?: string;
  className?: string;
};

/** The code input with its status line, for sets that show their drama elsewhere on the page. */
export function VerifyPanel({ verify, next, cellClassName, className }: VerifyPanelProps) {
  const { verified, routes } = verify;

  return (
    <div className={className}>
      <InputOTP
        // Remounting clears the input and replays the shake after a wrong code.
        key={verify.attempt}
        autoFocus
        maxLength={CODE_LENGTH}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        value={verify.code}
        onChange={verify.change}
        onComplete={verify.complete}
        disabled={verify.checking || verified || verify.locked > 0}
        aria-label="Verification code"
        {...verify.codeInputProps}
        containerClassName="block w-full has-disabled:opacity-100"
      >
        <div className={cn("grid w-full grid-cols-6 gap-2", verify.attempt > 0 && "animate-shake motion-reduce:animate-none")}>
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              style={{ transitionDelay: verified ? `${index * 60}ms` : undefined }}
              className={cn(
                "aspect-square border border-ink/30 text-2xl leading-none transition-colors duration-(--duration-base) motion-reduce:transition-none",
                "data-[active]:border-ink data-[filled]:border-ink",
                verified && "border-vermilion-deep! text-vermilion-deep!",
                cellClassName,
              )}
            />
          ))}
        </div>
      </InputOTP>

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
