"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { signInWithProvider, signUp } from "@/features/auth/client";
import { passwordRules, passwordScore, signupSchema } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { cn } from "@/lib/utils";
import { Field, FieldError, PasswordField } from "../field";
import { SocialButtons } from "../social-buttons";
import { StrengthMeter } from "../strength-meter";
import { SubmitButton } from "../submit-button";

type FormValues = { name: string; email: string; password: string; terms: boolean };

const SIGNUP_FIELDS = ["name", "email", "password", "terms"] as const;

export type SignupProgress = {
  name: string;
  email: string;
  /** The password itself never leaves the form, only how long and how strong it is. */
  passwordLength: number;
  /** From 0 to 1. */
  strength: number;
  terms: boolean;
};

type SignupFormProps = {
  /** "ledger" is numbered rows with oversized type, "stack" is a plain compact form, and "row" is a wide band. */
  layout?: "ledger" | "stack" | "row";
  onProgress?: (progress: SignupProgress) => void;
};

const largeInput = "h-13 text-2xl font-medium tracking-tight md:text-3xl";

function Row({ number, children }: { number: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[2.5rem_1fr] border-b border-rule px-5 py-4 md:grid-cols-[4rem_1fr] md:px-8">
      <span className="pt-0.5 font-mono text-[11px] tracking-[0.14em] text-ink-muted">{number}</span>
      <div>{children}</div>
    </div>
  );
}

export function SignupForm({ layout = "ledger", onProgress }: SignupFormProps) {
  const router = useRouter();
  const routes = useAuthRoutes();
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    // The checkbox starts unchecked, while the schema only accepts a checked box.
    resolver: zodResolver(signupSchema) as never,
    defaultValues: { name: "", email: "", password: "", terms: false },
    mode: "onTouched",
  });

  const values = useWatch({ control });
  const name = values.name ?? "";
  const email = values.email ?? "";
  const password = values.password ?? "";
  const terms = values.terms === true;
  const strength = passwordScore(password) / passwordRules.length;
  const steps = [
    name.trim().length >= 2,
    signupSchema.shape.email.safeParse(email).success,
    password.length >= 8,
    terms,
  ];
  const completed = steps.filter(Boolean).length;

  useEffect(() => {
    onProgress?.({ name, email, passwordLength: password.length, strength, terms });
  }, [onProgress, name, email, password.length, strength, terms]);

  async function onSubmit(form: FormValues) {
    if (locked > 0) return;
    const failure = await run("signup", () => signUp({ ...form, terms: true }), SIGNUP_FIELDS);
    if (!failure) router.push(routes.verify(form.email));
  }

  async function onProvider(provider: "google" | "github") {
    const failure = await run(provider, () => signInWithProvider(provider));
    if (!failure) router.push(routes.login);
  }

  const inputClass = layout === "ledger" ? largeInput : undefined;

  const nameField = (
    <Field
      label="Full name"
      autoComplete="name"
      placeholder="Your name"
      inputClassName={inputClass}
      error={errors.name?.message ?? fieldErrors.name}
      {...register("name", { onChange: () => clearFieldError("name") })}
    />
  );
  const emailField = (
    <Field
      label="Email"
      type="email"
      autoComplete="email"
      placeholder="you@studio.com"
      inputClassName={inputClass}
      error={errors.email?.message ?? fieldErrors.email}
      {...register("email", { onChange: () => clearFieldError("email") })}
    />
  );
  const passwordField = (
    <PasswordField
      label="Password"
      autoComplete="new-password"
      placeholder="Eight characters or more"
      inputClassName={inputClass}
      error={errors.password?.message ?? fieldErrors.password}
      {...register("password", { onChange: () => clearFieldError("password") })}
    />
  );
  const termsField = (
    <>
      <Controller
        control={control}
        name="terms"
        render={({ field }) => (
          <div className="flex items-start gap-3">
            <Checkbox
              id="terms"
              ref={field.ref}
              checked={field.value}
              onCheckedChange={(checked) => {
                field.onChange(checked === true);
                clearFieldError("terms");
              }}
              onBlur={field.onBlur}
              aria-invalid={errors.terms || fieldErrors.terms ? true : undefined}
              aria-describedby={errors.terms || fieldErrors.terms ? "terms-error" : undefined}
            />
            <Label htmlFor="terms" className="pt-0.5 leading-relaxed normal-case tracking-normal">
              I accept the terms and the privacy policy.
            </Label>
          </div>
        )}
      />
      <FieldError id="terms-error" message={errors.terms?.message ?? fieldErrors.terms} />
    </>
  );
  const actions = (
    <>
      <SubmitButton
        pending={pending === "signup"}
        disabled={locked > 0}
        pendingLabel="Creating your account"
      >
        Create account
      </SubmitButton>
      <SocialButtons disabled={pending !== null} onSelect={onProvider} />
      <p className="pt-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        Already a member?{" "}
        <Link href={routes.login} className="text-ink underline underline-offset-4 hover:text-vermilion-deep">
          Sign in
        </Link>
      </p>
    </>
  );

  if (layout === "row") {
    return (
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-x-8 gap-y-5 md:grid-cols-3 xl:grid-cols-12">
        <div className="xl:col-span-3">{nameField}</div>
        <div className="xl:col-span-3">{emailField}</div>
        <div className="xl:col-span-3">{passwordField}</div>
        <div className="flex flex-col justify-end gap-2 pb-1 xl:col-span-3">{termsField}</div>
        <div className="grid gap-3 md:col-span-3 md:grid-cols-[1fr_1fr_auto] md:items-center xl:col-span-12">
          <SubmitButton pending={pending === "signup"} disabled={locked > 0} pendingLabel="Creating your account">
            Create account
          </SubmitButton>
          <SocialButtons disabled={pending !== null} onSelect={onProvider} />
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            Member?{" "}
            <Link href={routes.login} className="text-ink underline underline-offset-4 hover:text-vermilion-deep">
              Sign in
            </Link>
          </p>
        </div>
      </form>
    );
  }

  if (layout === "stack") {
    return (
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
        {nameField}
        {emailField}
        {passwordField}
        <div>{termsField}</div>
        <div className="grid gap-3">{actions}</div>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col">
      <div className="flex items-center justify-between gap-6 border-b border-rule px-5 py-4 font-mono text-[11px] tracking-[0.14em] uppercase md:px-8">
        <span>New account</span>
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className="flex gap-1">
            {steps.map((done, index) => (
              <span
                // The four steps never reorder.
                key={index}
                className={cn("size-2.5 transition-colors duration-(--duration-slow)", done ? "bg-vermilion" : "bg-ink/15")}
              />
            ))}
          </span>
          {completed} of 4
        </span>
      </div>
      <Row number="01">{nameField}</Row>
      <Row number="02">{emailField}</Row>
      <Row number="03">
        {passwordField}
        <StrengthMeter password={password} className="mt-4" />
      </Row>
      <Row number="04">{termsField}</Row>
      <div className="grid gap-3 px-5 pt-4 pb-5 md:px-8">{actions}</div>
    </form>
  );
}
