"use client";

import { type ReactNode, useCallback, useState } from "react";
import { LiveClock } from "@/components/motion/live-clock";
import { Reveal } from "@/components/motion/reveal";
import { AuthHeader } from "../auth-header";
import { LoginForm } from "../forms/login-form";
import type { PasswordLockState } from "../password-lock";

/** Characters that take the shackle to its full travel. Matches the password length the form asks for. */
const TOTAL = 12;

/**
 * A static padlock drawn in ivory on the vermilion tile. The shackle rises as the password grows, opens on success
 * and spins while the server checks. Under reduced motion it jumps to each position and never spins. This is plain
 * SVG, so it shows on first paint with no Lottie to load.
 */
function MastheadPadlock({ length, state }: { length: number; state: PasswordLockState }) {
  const lift = state === "ok" ? 1 : Math.min(1, length / TOTAL);
  return (
    <svg
      viewBox="3 1.5 18 20.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="miter"
      className={`size-full text-ink transition-transform duration-(--duration-base) ease-(--ease-enter) motion-reduce:transition-none ${
        state === "pending" ? "animate-spin motion-reduce:animate-none" : ""
      }`}
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" />
      <g
        style={{ transform: `translateY(${-lift * 3}px)` }}
        className="transition-transform duration-(--duration-base) ease-(--ease-enter) motion-reduce:transition-none"
      >
        <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
      </g>
    </svg>
  );
}

/**
 * The sign-in fits one laptop screen with no scrolling. The masthead, the form and the demo accounts form one block,
 * centred in the left half. The art fills the right half from md up. Phones scroll.
 */
export default function Login({ side, demo }: { side?: ReactNode; demo?: ReactNode }) {
  const [passwordLength, setPasswordLength] = useState(0);
  const [lockState, setLockState] = useState<PasswordLockState>("idle");
  const onValues = useCallback((_email: string, length: number) => setPasswordLength(length), []);

  return (
    <main className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <AuthHeader index="01" section="Access" />

      <div className="grid min-h-0 flex-1 md:grid-cols-2">
        <div className="flex min-h-0 min-w-0 items-center px-5 py-8 md:px-[clamp(32px,5vw,96px)] md:py-[clamp(12px,3vh,32px)]">
          <div className="mx-auto grid w-full max-w-[600px] gap-[clamp(24px,5vh,48px)]">
            <div className="grid justify-items-start gap-[clamp(8px,2vh,20px)]">
              <div className="flex w-full justify-between font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
                <span>Sign in</span>
                <LiveClock />
              </div>
              {/* One tight phrase. The padlock sits on the line at cap height and follows the password as it is typed. */}
              <h1
                aria-label="Back in."
                className="leading-none font-semibold tracking-[-0.03em] whitespace-nowrap"
                style={{ fontSize: "clamp(72px, min(15vh, 24vw), 184px)" }}
              >
                <Reveal>Back</Reveal>{" "}
                <Reveal delay={0.12}>
                  <span
                    data-theme="dark"
                    aria-hidden="true"
                    className="inline-block size-[0.7em] overflow-hidden align-baseline bg-vermilion"
                  >
                    <MastheadPadlock length={passwordLength} state={lockState} />
                  </span>
                </Reveal>{" "}
                <Reveal delay={0.24}>in.</Reveal>
              </h1>
            </div>

            <div className="grid w-full gap-[clamp(12px,2.5vh,24px)]">
              <LoginForm layout="compact" onValues={onValues} onStatus={setLockState} />
              {demo}
            </div>
          </div>
        </div>

        {side ? <div className="relative hidden min-h-0 border-l border-ink md:block">{side}</div> : null}
      </div>
    </main>
  );
}
