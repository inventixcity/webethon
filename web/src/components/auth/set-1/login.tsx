"use client";

import { useCallback, useState } from "react";
import { LiveClock } from "@/components/motion/live-clock";
import { Reveal } from "@/components/motion/reveal";
import { Ticker } from "@/components/motion/ticker";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { LoginForm } from "../forms/login-form";
import { type PasswordLockState, PasswordLock } from "../password-lock";

const tickerItems = ["Welcome back", siteConfig.tagline, "Members only", "Pick up where you stopped"];

export default function Login() {
  const [passwordLength, setPasswordLength] = useState(0);
  const [lockState, setLockState] = useState<PasswordLockState>("idle");
  const onValues = useCallback((_email: string, length: number) => setPasswordLength(length), []);

  return (
    <main className="flex min-h-dvh flex-col overflow-hidden">
      <AuthHeader index="01" section="Access" />

      <div className="flex flex-1 flex-col justify-end gap-2 px-5 pt-6 md:px-8">
        <div className="flex justify-between font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          <span>Sign in</span>
          <LiveClock />
        </div>
        {/* The padlock is set in the line like a letter, so the headline is the artwork. It follows the password as it is typed. */}
        <h1
          aria-label="Back in."
          className="flex items-center justify-between text-[clamp(4.5rem,min(24vw,42vh),30rem)] leading-none font-semibold tracking-[-0.03em] md:text-[clamp(4.5rem,min(25.5vw,42vh),30rem)]"
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

      <LoginForm layout="strip" onValues={onValues} onStatus={setLockState} />

      <Ticker items={tickerItems} className="bg-ink py-3 text-paper" />
    </main>
  );
}
