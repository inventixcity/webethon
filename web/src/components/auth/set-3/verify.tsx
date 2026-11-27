"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { InputOTP } from "@/components/ui/input-otp";
import { maskEmail } from "@/features/auth/schemas";
import { CODE_LENGTH, useVerify } from "@/features/auth/use-verify";
import { cn } from "@/lib/utils";
import { AuthHeader } from "../auth-header";
import { CodeError } from "../forms/code-error";
import { Tumbler } from "./tumbler";

const linkStyle = "cursor-pointer underline underline-offset-4 hover:text-vermilion-deep disabled:text-ink-soft disabled:no-underline";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const verify = useVerify({ next });
  const { code, verified, routes } = verify;
  const progress = verified ? 1 : code.length / CODE_LENGTH;

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="04" section="Verification" />

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-5 py-8 md:px-8">
        <div className="text-center">
          <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
            <Reveal key={verified ? "done" : "wait"}>{verified ? "The door is open." : "Dial the code."}</Reveal>
          </h1>
          <p className="mt-3 text-base text-ink-soft">
            {verified
              ? "Every wheel is in line."
              : email
                ? `Six digits are on their way to ${maskEmail(email)}.`
                : "Six digits are on their way."}
          </p>
        </div>

        <div
          className={cn(
            "relative w-full max-w-2xl border border-ink bg-paper-raised p-3 [--cell:clamp(2.75rem,10dvh,5.25rem)] sm:p-5",
            verify.attempt > 0 && "animate-shake motion-reduce:animate-none",
          )}
          key={verify.attempt}
        >
          <div className="relative grid grid-cols-6 gap-1.5 sm:gap-3">
            {Array.from({ length: CODE_LENGTH }, (_, index) => (
              <Tumbler
                key={index}
                digit={code[index]}
                active={!verified && index === code.length}
                open={verified}
              />
            ))}
            {/* The sight line every wheel has to reach. */}
            <span className="pointer-events-none absolute inset-x-0 top-[calc(var(--cell))] h-px bg-vermilion" />
            <span className="pointer-events-none absolute inset-x-0 top-[calc(var(--cell)*2)] h-px bg-vermilion" />
          </div>

          {/* The bolt slides back as the wheels are set, and clears the frame when they all line up. */}
          <div className="mt-3 h-4 overflow-hidden border border-rule sm:mt-5">
            <div
              className="h-full bg-ink transition-transform duration-(--duration-slow) ease-(--ease-move) motion-reduce:transition-none"
              style={{ transform: `translateX(${progress * 100}%)` }}
            />
          </div>

          {/* The real input sits over the wheels, invisible, so typing, paste and autofill all work. */}
          <InputOTP
            autoFocus
            maxLength={CODE_LENGTH}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            value={code}
            onChange={verify.change}
            onComplete={verify.complete}
            disabled={verify.checking || verified || verify.locked > 0}
            aria-label="Verification code"
            {...verify.codeInputProps}
            containerClassName="absolute! inset-0 has-disabled:opacity-100"
          >
            <span />
          </InputOTP>
        </div>

        <div className="min-h-14 w-full max-w-2xl font-mono text-[11px] tracking-[0.12em] uppercase">
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
                  <span className="text-ink-muted">
                    {verify.checking ? "Checking the wheels" : "Just type. Paste works too."}
                  </span>
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
      </div>
    </main>
  );
}
