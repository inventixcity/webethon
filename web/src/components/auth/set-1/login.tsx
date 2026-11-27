"use client";

import { type ReactNode, useCallback, useState } from "react";
import { LiveClock } from "@/components/motion/live-clock";
import { Reveal } from "@/components/motion/reveal";
import { Ticker } from "@/components/motion/ticker";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { LoginForm } from "../forms/login-form";
import { type PasswordLockState, PasswordLock } from "../password-lock";

const tickerItems = ["Welcome back", siteConfig.tagline, "Members only", "Pick up where you stopped"];

/**
 * The sign-in fits one laptop screen with no scrolling. The headline scales with the viewport height, the form and
 * the demo accounts sit under it, and the art fills the right column. Small phones scroll.
 */
export default function Login({ side, demo }: { side?: ReactNode; demo?: ReactNode }) {
  const [passwordLength, setPasswordLength] = useState(0);
  const [lockState, setLockState] = useState<PasswordLockState>("idle");
  const onValues = useCallback((_email: string, length: number) => setPasswordLength(length), []);

  return (
    <main className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <AuthHeader index="01" section="Access" />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_min(34vw,28rem)]">
        <div className="flex min-h-0 min-w-0 flex-col justify-between gap-6 px-5 py-6 md:px-8 md:py-[clamp(12px,3vh,32px)]">
          <div className="grid gap-[clamp(8px,2vh,20px)]">
            <div className="flex justify-between font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
              <span>Sign in</span>
              <LiveClock />
            </div>
            {/* The padlock is set in the line like a letter, so the headline is the artwork. It follows the password as it is typed. */}
            <h1
              aria-label="Back in."
              className="flex items-center justify-between text-[clamp(56px,min(15vh,24vw),184px)] leading-none font-semibold tracking-[-0.03em]"
            >
              <Reveal>Back</Reveal>
              <Reveal delay={0.12} className="pb-0">
                <span data-theme="dark" className="block size-[0.74em] overflow-hidden bg-vermilion">
                  <PasswordLock length={passwordLength} state={lockState} className="scale-[1.55]" />
                </span>
              </Reveal>
              <Reveal delay={0.24}>in.</Reveal>
            </h1>
          </div>

          <div className="grid w-full max-w-2xl gap-[clamp(12px,2.5vh,24px)]">
            <LoginForm layout="compact" onValues={onValues} onStatus={setLockState} />
            {demo}
          </div>
        </div>

        {side ? <div className="hidden min-h-0 border-l border-ink lg:block">{side}</div> : null}
      </div>

      <Ticker items={tickerItems} className="h-8 shrink-0 items-center bg-ink text-paper" />
    </main>
  );
}
