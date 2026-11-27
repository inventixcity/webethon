"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { resetPassword } from "@/features/auth/client";
import { passwordRules, passwordScore, type ResetValues, resetSchema } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { PasswordField } from "../field";
import { StrengthMeter } from "../strength-meter";
import { SubmitButton } from "../submit-button";

/** The fields a reset error can name. A weak password is named "password". */
const RESET_FIELDS = ["password", "confirm"] as const;

type ResetFormProps = {
  /** "band" spreads across the page. "column" stacks it. */
  layout?: "band" | "column";
  /** Leave out the strength meter, for screens that show strength their own way. */
  hideMeter?: boolean;
  onValues?: (password: string, confirm: string, strength: number) => void;
  onDone?: () => void;
};

export function ResetForm({ layout = "band", hideMeter = false, onValues, onDone }: ResetFormProps) {
  const routes = useAuthRoutes();
  const { pending, locked, fieldErrors, clearFieldError, run } = useAuthAction();
  const [done, setDone] = useState(false);
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirm: "" },
    mode: "onTouched",
  });
  const password = useWatch({ control, name: "password" });
  const confirm = useWatch({ control, name: "confirm" });

  useEffect(() => {
    onValues?.(password, confirm, passwordScore(password) / passwordRules.length);
  }, [onValues, password, confirm]);

  async function onSubmit(values: ResetValues) {
    if (locked > 0) return;
    const failure = await run("reset", () => resetPassword(values.password), RESET_FIELDS);
    if (!failure) {
      setDone(true);
      onDone?.();
    }
  }

  if (done) {
    return (
      <div
        className={
          layout === "band"
            ? "flex flex-wrap items-center justify-between gap-6 px-5 py-10 md:px-8"
            : "flex flex-col items-start gap-6"
        }
      >
        <p className="text-[clamp(2rem,4vw,3.5rem)] leading-none font-medium tracking-[-0.03em]">Password changed.</p>
        <Button asChild size="lg" className="min-w-56 justify-between">
          <Link href={routes.login}>
            Sign in
            <ArrowRight />
          </Link>
        </Button>
      </div>
    );
  }

  const newPassword = (
    <>
      <PasswordField
        label="New password"
        autoComplete="new-password"
        placeholder="Eight characters or more"
        error={errors.password?.message ?? fieldErrors.password}
        {...register("password", { onChange: () => clearFieldError("password") })}
      />
      {!hideMeter && <StrengthMeter password={password} className="mt-4" />}
    </>
  );
  const repeat = (
    <PasswordField
      label="Type it again"
      autoComplete="new-password"
      placeholder="Same as before"
      error={errors.confirm?.message ?? fieldErrors.confirm}
      {...register("confirm", { onChange: () => clearFieldError("confirm") })}
    />
  );
  const actions = (
    <>
      <SubmitButton pending={pending === "reset"} disabled={locked > 0} pendingLabel="Saving" className="w-full">
        Save password
      </SubmitButton>
      <Link
        href={routes.login}
        className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase underline-offset-4 hover:text-vermilion-deep hover:underline"
      >
        Back to sign in
      </Link>
    </>
  );

  if (layout === "column") {
    return (
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
        <div>{newPassword}</div>
        {repeat}
        <div className="flex flex-col gap-3">{actions}</div>
      </form>
    );
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit(onSubmit)}
      className="grid gap-x-10 gap-y-5 px-5 py-5 md:grid-cols-12 md:px-8 md:py-6"
    >
      <div className="md:col-span-5">{newPassword}</div>
      <div className="md:col-span-4">{repeat}</div>
      <div className="flex flex-col justify-start gap-3 pt-3 md:col-span-3">{actions}</div>
    </form>
  );
}
