"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { requestReset } from "@/features/auth/client";
import { forgotSchema, maskEmail } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { easingCss, useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AuthHeader } from "../auth-header";
import { FieldError } from "../field";
import { SubmitButton } from "../submit-button";

const FEED_MS = 900;
const quietLink = "font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4 hover:text-vermilion-deep";

export default function Forgot() {
  const routes = useAuthRoutes();
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [feeding, setFeeding] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const hammerRef = useRef<HTMLSpanElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const valid = forgotSchema.safeParse({ email }).success;

  useEffect(() => {
    if (!sentTo) inputRef.current?.focus({ preventScroll: true });
  }, [sentTo]);

  /** One press of a key: the hammer swings and the whole sheet jolts against the platen. */
  function strike() {
    if (reduced) return;
    hammerRef.current?.animate(
      [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }, { transform: "scaleY(0)" }],
      { duration: 110, easing: easingCss.enter },
    );
    sheetRef.current?.animate([{ translate: "0 0" }, { translate: "0 3px" }, { translate: "0 0" }], { duration: 90 });
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) {
      setInvalid(true);
      return;
    }
    if (locked > 0) return;
    const failure = await run("send", () => requestReset(email), ["email"]);
    if (failure) return;
    setFeeding(true);
    window.setTimeout(
      () => {
        setSentTo(email);
        setFeeding(false);
      },
      reduced ? 0 : FEED_MS,
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="03" section="Recovery" />

      {sentTo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-8 px-5 py-10 text-center">
          <h1 className="text-[clamp(2.5rem,6vw,5.5rem)] leading-none font-semibold tracking-[-0.03em]">
            <Reveal className="block">Letter sent</Reveal>
            <Reveal className="block" delay={0.1}>
              to {maskEmail(sentTo)}
            </Reveal>
          </h1>
          <div className="flex flex-wrap items-center justify-center gap-6">
            <Button asChild size="lg" className="justify-between gap-10">
              <Link href={routes.verify(sentTo, "reset")}>
                Enter the code
                <ArrowRight />
              </Link>
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                setSentTo(undefined);
                setEmail("");
              }}
              className="font-mono text-[11px] tracking-[0.12em] uppercase overflow-visible"
            >
              Write another
            </Button>
          </div>
        </div>
      ) : (
        <form noValidate onSubmit={onSubmit} className="flex flex-1 flex-col">
          <h1 className="sr-only">Forgot your password</h1>

          {/* The window onto the sheet. Everything below the typing line is behind the platen. */}
          <div
            // Clip rather than hide, or the browser scrolls the sheet sideways to reveal the input.
            className="relative min-h-80 flex-1 cursor-text overflow-clip bg-paper-sunk"
            onPointerDown={(event) => {
              event.preventDefault();
              inputRef.current?.focus({ preventScroll: true });
            }}
          >
            <div
              ref={sheetRef}
              // The carriage: the sheet slides left one character at a time, so the typing point
              // stays still. Feeding it out sends the whole sheet up off the top.
              style={
                {
                  "--typed": Math.min(email.length, 44),
                  transform: `translate(calc(var(--typed) * var(--carriage) * -1ch), ${feeding ? "-130%" : "0"})`,
                  transition: feeding
                    ? reduced
                      ? "none"
                      : `transform ${FEED_MS}ms ${easingCss.move}`
                    : "transform 70ms steps(2, end)",
                } as React.CSSProperties
              }
              // Phones are too narrow for a moving carriage, which would push the typing off-screen.
              className="absolute bottom-[-4.5rem] left-[-3ch] flex h-[120%] w-[66ch] flex-col justify-end border-x border-t border-rule bg-paper-raised px-[5ch] pb-20 font-mono text-base leading-loose text-ink [--carriage:0] sm:left-[calc(50%-9ch)] sm:px-[9ch] sm:text-lg sm:[--carriage:1] md:text-xl"
            >
              <p className="font-sans text-[clamp(2.5rem,4.5vw,4.25rem)] leading-none font-semibold tracking-[-0.03em]">
                Keys get lost.
              </p>
              <p className="mt-2 text-ink-muted">Recovery desk</p>
              <p className="mt-6">Dear keeper,</p>
              <p className="mt-6">I have lost my key.</p>
              <p>Please send a new one to:</p>
              <label htmlFor="typed-email" className="sr-only">
                Email address
              </label>
              <input
                ref={inputRef}
                id="typed-email"
                type="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="you@studio.com"
                value={email}
                aria-invalid={invalid || fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? "typed-email-error" : undefined}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setInvalid(false);
                  clearFieldError("email");
                  strike();
                }}
                className="mt-6 w-full border-0 bg-transparent font-medium text-vermilion-deep caret-vermilion outline-none placeholder:text-ink/20"
              />
            </div>
          </div>

          {/* The platen: a solid roller with knobs at both ends. */}
          <div className="relative z-10 flex h-12 items-center justify-between bg-ink px-3">
            <span className="size-6 bg-paper" />
            <span
              ref={hammerRef}
              aria-hidden="true"
              className="absolute bottom-full left-1/2 h-8 w-1 origin-bottom scale-y-0 bg-vermilion"
            />
            <span className="absolute top-0 left-1/2 size-2 -translate-x-1/2 bg-vermilion" />
            <span className="size-6 bg-paper" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 md:px-8">
            <div aria-live="polite" className="min-h-4 font-mono text-[11px] tracking-[0.12em] uppercase">
              {invalid || fieldErrors.email ? (
                <FieldError id="typed-email-error" message={fieldErrors.email ?? "Enter a valid email address"} />
              ) : (
                <span className={valid ? "text-vermilion-deep" : "text-ink-muted"}>
                  {valid ? "Ding. Ready to send." : "Just start typing."}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <Link href={routes.login} className={quietLink}>
                I remembered it
              </Link>
              <SubmitButton pending={pending === "send"} disabled={locked > 0} pendingLabel="Sending" className="min-w-56">
                Send the letter
              </SubmitButton>
            </div>
          </div>
        </form>
      )}
    </main>
  );
}
