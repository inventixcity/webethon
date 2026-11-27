"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { type RadarStatus, RadarScene } from "@/components/ascii/scenes/radar";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPSlot } from "@/components/ui/input-otp";
import { maskEmail } from "@/features/auth/schemas";
import { CODE_LENGTH, useVerify, type VerifyStatus } from "@/features/auth/use-verify";
import { cn } from "@/lib/utils";
import { AuthHeader } from "../auth-header";
import { CodeError } from "../forms/code-error";

const radarStatus: Record<VerifyStatus, RadarStatus> = {
  idle: "listening",
  checking: "checking",
  wrong: "wrong",
  verified: "locked",
};

const linkStyle = "cursor-pointer underline underline-offset-4 hover:text-vermilion-deep disabled:text-ink-soft disabled:no-underline";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const [radar] = useState(() => new RadarScene());
  const verify = useVerify({
    next,
    onCode: (code) => radar.setCode(code),
    onStatus: (status) => radar.setStatus(radarStatus[status]),
  });
  const { verified, routes } = verify;

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="04" section="Verification" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col justify-center px-5 py-10 md:px-10 xl:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal key={verified ? "done" : "wait"}>{verified ? "You're verified." : "Check your inbox."}</Reveal>
            </h1>
            <p className="mt-3 mb-9 text-base text-ink-soft">
              {verified
                ? "Signal locked."
                : email
                  ? `Six digits are on their way to ${maskEmail(email)}.`
                  : "Six digits are on their way."}
            </p>

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
                      "aspect-square border border-ink/30 text-2xl leading-none font-medium transition-colors duration-(--duration-base) sm:text-3xl",
                      "data-[active]:border-ink data-[filled]:border-ink data-[filled]:bg-ink data-[filled]:text-paper",
                      verified && "border-vermilion-deep! bg-vermilion-deep! text-paper!",
                    )}
                  />
                ))}
              </div>
            </InputOTP>

            <div className="mt-6 min-h-16 font-mono text-[11px] tracking-[0.12em] uppercase">
              {verified && next !== "reset" ? (
                <Button asChild size="lg" className="w-full justify-between">
                  <Link href={routes.login}>
                    Continue
                    <ArrowRight />
                  </Link>
                </Button>
              ) : (
                <div className="grid gap-3">
                  <div aria-live="polite">
                    {verify.codeError ? (
                      <CodeError verify={verify} />
                    ) : (
                      <span className="text-ink-muted">
                        {verify.checking ? "Checking the code" : "Paste works too. It fills itself."}
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
        </section>

        <div className="relative min-h-[44dvh] border-rule p-4 md:p-8 lg:border-l">
          <AsciiCanvas
            scene={radar}
            className="absolute inset-4 size-[calc(100%-2rem)] md:inset-8 md:size-[calc(100%-4rem)]"
          />
        </div>
      </div>
    </main>
  );
}
