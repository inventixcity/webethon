"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { requestReset } from "@/features/auth/client";
import { type ForgotValues, forgotSchema } from "@/features/auth/schemas";
import { useAuthAction } from "@/features/auth/use-auth-action";
import { useAuthRoutes } from "@/features/auth/use-auth-routes";
import { Field } from "../field";
import { SubmitButton } from "../submit-button";

const quietLink =
  "inline-flex min-h-11 items-center font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4 hover:text-vermilion-deep";

type ForgotFieldProps = {
  /** Called on every change, with how much was typed and whether it's a valid address. */
  onType?: (length: number, valid: boolean) => void;
  onSent?: (sent: boolean) => void;
  onError?: () => void;
  /** Sets the button's label to suit the page. */
  submitLabel?: string;
  /** Lays the field and button side by side. */
  row?: boolean;
};

/** Forgot password as one plain field, for sets where the page's scene does the talking. */
export function ForgotField({ onType, onSent, onError, submitLabel = "Send reset code", row = false }: ForgotFieldProps) {
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

  useEffect(() => {
    if (!sentTo) setFocus("email");
  }, [sentTo, setFocus]);

  async function onSubmit({ email }: ForgotValues) {
    if (locked > 0) return;
    const failure = await run("send", () => requestReset(email), ["email"]);
    if (!failure) {
      setSentTo(email);
      onSent?.(true);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-lg">If an account exists for {sentTo}, a 6-digit code is on its way. It expires in 15 minutes.</p>
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
    <form
      noValidate
      onSubmit={handleSubmit(onSubmit, onError)}
      className={row ? "grid items-end gap-6 md:grid-cols-[1fr_auto]" : "flex flex-col gap-6"}
    >
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@institution.edu"
        error={errors.email?.message ?? fieldErrors.email}
        {...emailField}
        onChange={(event) => {
          emailField.onChange(event);
          const { value } = event.target;
          onType?.(value.length, forgotSchema.safeParse({ email: value }).success);
        }}
      />
      <div className="flex flex-col gap-3">
        <SubmitButton
          pending={pending === "send"}
          disabled={locked > 0}
          pendingLabel="Sending"
          className="min-w-56"
        >
          {submitLabel}
        </SubmitButton>
        <Link href={routes.login} className={quietLink}>
          I remembered it
        </Link>
      </div>
    </form>
  );
}
