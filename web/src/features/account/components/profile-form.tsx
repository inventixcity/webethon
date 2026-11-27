"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { updateProfile } from "../client";
import { showFormError } from "../errors";
import { profileSchema, type ProfileValues } from "../schemas";
import type { Profile } from "../types";
import { Feedback } from "./feedback";

const PROFILE_FIELDS = ["displayName", "avatarUrl"] as const;

function toFormValues(profile: Profile): ProfileValues {
  return { displayName: profile.displayName, avatarUrl: profile.avatarUrl ?? "" };
}

export function ProfileForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const toast = useToast();
  // The last saved profile. Edits show here straight away, and roll back if the API refuses them.
  const [saved, setSaved] = useState(profile);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: toFormValues(profile),
    mode: "onTouched",
  });

  async function onSubmit(values: ProfileValues) {
    const avatarUrl = values.avatarUrl === "" ? null : values.avatarUrl;
    const previous = saved;

    setSaved({ ...previous, displayName: values.displayName, avatarUrl });
    setNotice(undefined);
    setPending(true);

    try {
      const updated = await updateProfile({ displayName: values.displayName, avatarUrl });
      setSaved(updated);
      reset(toFormValues(updated));
      setNotice("Profile saved.");
      // The header and home page show the name, so ask the server for fresh renders of them.
      router.refresh();
    } catch (cause) {
      setSaved(previous);
      showFormError(cause, PROFILE_FIELDS, toast, (field, message) => {
        setError(field, { message });
        setFocus(field);
      });
    } finally {
      setPending(false);
    }
  }

  const shownAs = saved.displayName.trim() || saved.email;

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-8">
      <Field
        label="Display name"
        autoComplete="name"
        placeholder="Your name"
        error={errors.displayName?.message}
        {...register("displayName")}
      />
      <Field
        label="Avatar URL"
        type="url"
        inputMode="url"
        autoComplete="url"
        placeholder="https://"
        error={errors.avatarUrl?.message}
        {...register("avatarUrl")}
      />

      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center bg-ink font-mono text-lg text-paper uppercase"
        >
          {shownAs.charAt(0)}
        </span>
        <p className="min-w-0 break-words text-ink-soft">
          Shown as <span className="text-ink">{shownAs}</span>
        </p>
      </div>

      <Feedback message={notice} />

      <div>
        <SubmitButton pending={pending} pendingLabel="Saving" disabled={pending || !isDirty}>
          Save profile
        </SubmitButton>
      </div>
    </form>
  );
}
