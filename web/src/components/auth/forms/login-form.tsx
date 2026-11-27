"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { signIn } from "@/features/auth/client";
import { type LoginValues, loginSchema } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { Field, PasswordField } from "../field";
import { SubmitButton } from "../submit-button";

const quietLink =
  "font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase underline-offset-4 hover:text-vermilion-deep hover:underline";

/** Roughly how many characters fill the email field, for turning the caret into a position. */
const FIELD_CHARS = 30;

export type LoginStatus = "pending" | "ok" | "wrong";

/** The fields a sign-in error can name. A wrong password and an unknown email share one message. */
const LOGIN_FIELDS = ["email", "password"] as const;

/** Everything a scene might want to react to. The password only ever leaves as a length. */
export type LoginEvents = {
  onValues?: (email: string, passwordLength: number) => void;
  onEmailFocus?: () => void;
  /** The caret's position along the email field, from 0 to 1. */
  onCaret?: (position: number) => void;
  onPasswordFocus?: (shown: boolean) => void;
  onReveal?: (shown: boolean) => void;
  onLeave?: () => void;
  onStatus?: (status: LoginStatus) => void;
};

type LoginFormProps = LoginEvents & {
  /** "strip" lays the form out in a wide band. "column" stacks it. "compact" stacks the fields and sets the button beside the note. */
  layout?: "strip" | "column" | "compact";
};

export function LoginForm({
  layout = "column",
  onValues,
  onEmailFocus,
  onCaret,
  onPasswordFocus,
  onReveal,
  onLeave,
  onStatus,
}: LoginFormProps) {
  const routes = useAuthRoutes();
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();
  const [signedIn, setSignedIn] = useState(false);
  const shown = useRef(false);
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onTouched",
  });

  const email = useWatch({ control, name: "email" });
  const password = useWatch({ control, name: "password" });

  useEffect(() => {
    onValues?.(email, password.length);
  }, [onValues, email, password]);

  const emailField = register("email", { onChange: () => clearFieldError("email") });
  const passwordField = register("password", { onChange: () => clearFieldError("password") });

  function trackCaret(input: HTMLInputElement) {
    const caret = input.selectionStart ?? input.value.length;
    onCaret?.(Math.min(1, caret / FIELD_CHARS));
  }

  async function attempt(key: string, action: () => Promise<void>, fields?: readonly string[]) {
    onStatus?.("pending");
    const failure = await run(key, action, fields);
    if (!failure) setSignedIn(true);
    onStatus?.(failure ? "wrong" : "ok");
  }

  const fields = (
    <>
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@institution.edu"
        error={errors.email?.message ?? fieldErrors.email}
        {...emailField}
        onChange={(event) => {
          emailField.onChange(event);
          trackCaret(event.target);
        }}
        onSelect={(event) => trackCaret(event.currentTarget)}
        onFocus={(event) => {
          onEmailFocus?.();
          trackCaret(event.target);
        }}
        onBlur={(event) => {
          emailField.onBlur(event);
          onLeave?.();
        }}
      />
      <PasswordField
        label="Password"
        autoComplete="current-password"
        placeholder="••••••••"
        error={errors.password?.message ?? fieldErrors.password}
        action={
          <Link href={routes.forgot} className={quietLink}>
            Forgot it?
          </Link>
        }
        onVisibleChange={(visible) => {
          shown.current = visible;
          onReveal?.(visible);
        }}
        {...passwordField}
        onFocus={() => onPasswordFocus?.(shown.current)}
        onBlur={(event) => {
          passwordField.onBlur(event);
          // Moving focus onto the Show button isn't really leaving.
          if (!event.relatedTarget) onLeave?.();
        }}
      />
    </>
  );

  const actions = (
    <>
      <div aria-live="polite">
        {signedIn && <p className="font-mono text-[11px] tracking-wide">You&apos;re in.</p>}
      </div>
      <SubmitButton
        pending={pending === "password"}
        disabled={locked > 0}
        pendingLabel="Signing in"
        className="w-full"
      >
        Sign in
      </SubmitButton>
    </>
  );

  const signup = (
    <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
      Accounts are created by your institution.
    </p>
  );

  const submit = handleSubmit((values) => {
    if (locked === 0) return attempt("password", () => signIn(values), LOGIN_FIELDS);
  });

  if (layout === "strip") {
    return (
      <form
        noValidate
        onSubmit={submit}
        className="grid gap-x-10 gap-y-8 border-t border-ink px-5 py-8 md:grid-cols-12 md:px-8"
      >
        <div className="flex flex-col justify-between gap-6 md:col-span-3">
          <p className="max-w-[20ch] text-xl leading-tight font-medium tracking-tight">
            Everything is exactly where you left it.
          </p>
          {signup}
        </div>
        <div className="grid content-start gap-6 md:col-span-5">{fields}</div>
        <div className="flex flex-col justify-end gap-3 md:col-span-4">{actions}</div>
      </form>
    );
  }

  if (layout === "compact") {
    return (
      <form noValidate onSubmit={submit} className="grid gap-4">
        {fields}
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-6">
          <div className="min-w-0 md:flex-1">{signup}</div>
          <div className="grid gap-2 md:w-64 md:shrink-0">{actions}</div>
        </div>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      {fields}
      <div className="flex flex-col gap-3">{actions}</div>
      {signup}
    </form>
  );
}
