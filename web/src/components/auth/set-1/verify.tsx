"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LottieLoop } from "@/components/motion/lottie-loop";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPSlot } from "@/components/ui/input-otp";
import { maskEmail } from "@/features/auth/schemas";
import { CODE_LENGTH, useVerify } from "@/features/auth/use-verify";
import { cn } from "@/lib/utils";
import { AuthHeader } from "../auth-header";
import { CodeError } from "../forms/code-error";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const verify = useVerify({ next });
  const { verified, routes } = verify;

  return (
    <main className="flex min-h-dvh flex-col overflow-hidden">
      <AuthHeader index="04" section="Verification" />

      <div className="grid flex-1 items-end gap-8 px-5 py-8 md:grid-cols-12 md:px-8">
        <h1 className="text-[clamp(3.5rem,min(12.5vw,23vh),14rem)] leading-none font-semibold tracking-[-0.03em] md:col-span-8">
          {verified ? (
            <Reveal className="block">Verified.</Reveal>
          ) : (
            <>
              <Reveal className="block">Check your</Reveal>
              <Reveal className="-mt-[0.14em] block" delay={0.1}>
                inbox.
              </Reveal>
            </>
          )}
        </h1>

        <div className="flex items-end gap-4 md:col-span-4 md:justify-end">
          <p className="max-w-[24ch] font-mono text-[11px] leading-relaxed tracking-wide text-ink-muted uppercase md:text-right">
            {email ? `Six digits sent to ${maskEmail(email)}` : "Six digits are on their way"}
          </p>
          <div className="size-28 shrink-0 overflow-hidden border border-ink bg-paper-raised md:size-[min(15vw,25vh)]">
            <LottieLoop src="/lottie/envelope.json" speed={0.8} className="scale-[1.5]" />
          </div>
        </div>
      </div>

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
        <div
          className={cn(
            "grid w-full grid-cols-6 divide-x divide-ink border-y border-ink",
            verify.attempt > 0 && "animate-shake motion-reduce:animate-none",
            verify.checking && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              style={{ transitionDelay: verified ? `${index * 60}ms` : undefined }}
              className={cn(
                "aspect-square text-[clamp(2.25rem,9vw,8.5rem)] leading-none transition-colors duration-(--duration-slow) md:aspect-auto md:h-[clamp(5.5rem,24dvh,15rem)]",
                "data-[active]:bg-paper-raised data-[filled]:bg-ink data-[filled]:text-paper",
                verified && "bg-vermilion-deep! text-paper!",
              )}
            />
          ))}
        </div>
      </InputOTP>

      <div className="flex min-h-20 flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 font-mono text-[11px] tracking-[0.12em] uppercase md:px-8">
        {verified ? (
          <>
            <span>Your email is confirmed.</span>
            <Button asChild className="justify-between gap-10">
              <Link href={routes.login}>
                Continue
                <ArrowRight />
              </Link>
            </Button>
          </>
        ) : (
          <>
            <div aria-live="polite">
              {verify.codeError ? (
                <CodeError verify={verify} />
              ) : (
                <span className="text-ink-muted">Paste works too. It fills itself.</span>
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
              <Link href={routes.signup} className="underline underline-offset-4 hover:text-vermilion-deep">
                Wrong email?
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
