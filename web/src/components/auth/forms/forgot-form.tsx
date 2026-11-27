"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { requestReset } from "@/features/auth/client";
import { type ForgotValues, forgotSchema } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { FieldError } from "../field";
import { SubmitButton } from "../submit-button";

const sentenceType = "text-[clamp(2.5rem,6vw,6.75rem)] leading-[1.02] font-medium tracking-[-0.035em]";
const FORGOT_FIELDS = ["email"] as const;
const EMAIL_ERROR_ID = "forgot-email-error";

type ForgotFormProps = {
  /** Called on every change, with how much was typed and whether it's a valid address. */
  onType?: (length: number, valid: boolean) => void;
  onSent?: (sent: boolean) => void;
  onError?: () => void;
};

export function ForgotForm({ onType, onSent, onError }: ForgotFormProps) {
  const routes = useAuthRoutes();
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();
  const [sentTo, setSentTo] = useState<string>();
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: "" },
  });

  const emailField = register("email", { onChange: () => clearFieldError("email") });
  const emailError = errors.email?.message ?? fieldErrors.email;

  useEffect(() => {
    if (!sentTo) setFocus("email");
  }, [sentTo, setFocus]);

  async function onSubmit({ email }: ForgotValues) {
    if (locked > 0) return;
    const failure = await run("send", () => requestReset(email), FORGOT_FIELDS);
    if (!failure) {
      setSentTo(email);
      onSent?.(true);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-10">
        {/* Neutral on purpose: the same answer whether or not an account exists, so nothing is revealed. */}
        <div>
          <h1 className={sentenceType}>
            <Reveal className="block">If an account exists</Reveal>
            <Reveal className="block" delay={0.1}>
              for {sentTo},
            </Reveal>
          </h1>
          <p className="mt-6 max-w-[34ch] text-lg text-ink-soft">
            a 6-digit code is on its way. It expires in 15 minutes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
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
              onSent?.(false);
            }}
            className="font-mono text-[11px] tracking-[0.12em] uppercase overflow-visible"
          >
            Use a different email
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit, onError)} className="flex flex-col gap-10">
      {/* The input is part of the sentence, so the page reads as one line of thought. */}
      <div className={sentenceType}>
        <h1>
          <Reveal className="block">Keys get lost.</Reveal>
          <Reveal className="block" delay={0.1}>
            Send a new one to
          </Reveal>
        </h1>
        <div className="group/field relative mt-[0.08em]">
          <label htmlFor="email" className="sr-only">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="your email"
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? EMAIL_ERROR_ID : undefined}
            className="w-full border-0 border-b-2 border-ink bg-transparent pb-[0.08em] text-vermilion-deep caret-vermilion outline-none placeholder:text-ink/25"
            {...emailField}
            onChange={(event) => {
              emailField.onChange(event);
              const { value } = event.target;
              onType?.(value.length, forgotSchema.safeParse({ email: value }).success);
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1 origin-left scale-x-0 bg-vermilion transition-transform duration-(--duration-slow) ease-(--ease-enter) motion-reduce:transition-none group-focus-within/field:scale-x-100"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <SubmitButton pending={pending === "send"} disabled={locked > 0} pendingLabel="Sending" className="min-w-56">
          Send reset code
        </SubmitButton>
        <Link
          href={routes.login}
          className="font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4 hover:text-vermilion-deep"
        >
          I remembered it
        </Link>
      </div>
      <div aria-live="polite" className="-mt-6 min-h-4">
        <FieldError id={EMAIL_ERROR_ID} message={emailError} />
      </div>
    </form>
  );
}
