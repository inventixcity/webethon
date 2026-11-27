"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { PasswordField } from "@/components/auth/field";
import { StrengthMeter } from "@/components/auth/strength-meter";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import { changePassword } from "../client";
import { showFormError } from "../errors";
import { passwordChangeSchema, type PasswordValues } from "../schemas";
import { Feedback } from "./feedback";

const PASSWORD_FIELDS = ["currentPassword", "newPassword"] as const;
const EMPTY_VALUES: PasswordValues = { currentPassword: "", newPassword: "", confirm: "" };
const WRONG_CURRENT = "That isn't your current password. Check it and try again.";

type PasswordFormProps = {
  /** Called after a change, because the other devices were signed out. */
  onChanged: () => void;
};

export function PasswordForm({ onChanged }: PasswordFormProps) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    setValue,
    formState: { errors },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordChangeSchema),
    defaultValues: EMPTY_VALUES,
    mode: "onTouched",
  });
  const newPassword = useWatch({ control, name: "newPassword" });

  async function onSubmit(values: PasswordValues) {
    setPending(true);
    setNotice(undefined);

    try {
      await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      reset(EMPTY_VALUES);
      setNotice("Password changed. Your other devices have been signed out.");
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "INVALID_CREDENTIALS") {
        // A wrong current password is a field error. Clear the guess and put the cursor back to try again.
        setValue("currentPassword", "");
        setError("currentPassword", { message: WRONG_CURRENT });
        setFocus("currentPassword");
      } else if (cause instanceof ApiError && cause.code === "WEAK_PASSWORD") {
        setError("newPassword", { message: describeError(cause).message });
        setFocus("newPassword");
      } else {
        showFormError(cause, PASSWORD_FIELDS, toast, (field, message) => {
          setError(field, { message });
          setFocus(field);
        });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-8">
      <PasswordField
        label="Current password"
        autoComplete="current-password"
        error={errors.currentPassword?.message}
        {...register("currentPassword")}
      />

      <div>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          placeholder="Eight characters or more"
          error={errors.newPassword?.message}
          {...register("newPassword")}
        />
        <StrengthMeter password={newPassword} className="mt-4" />
      </div>

      <PasswordField
        label="Type it again"
        autoComplete="new-password"
        placeholder="Same as before"
        error={errors.confirm?.message}
        {...register("confirm")}
      />

      <Feedback message={notice} />

      <div>
        <SubmitButton pending={pending} pendingLabel="Changing">
          Change password
        </SubmitButton>
      </div>
    </form>
  );
}
