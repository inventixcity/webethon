"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { showFormError, staleReloadOptions } from "@/features/account/errors";
import { createTeam } from "@/features/teams/client";
import { isTakenName, TAKEN_NAME_MESSAGE, teamToastFor } from "@/features/teams/errors";
import { teamNameSchema, type TeamNameValues } from "@/features/teams/schemas";

const NAME_FIELDS = ["name"] as const;

export function CreateTeamForm() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<TeamNameValues>({
    resolver: zodResolver(teamNameSchema),
    defaultValues: { name: "" },
    mode: "onTouched",
  });

  async function onSubmit(values: TeamNameValues) {
    setPending(true);
    try {
      const team = await createTeam(values.name);
      // Stay pending while the next page loads, so the button doesn't flicker back on.
      router.push(`/app/teams/${encodeURIComponent(team.id)}`);
    } catch (cause) {
      if (isTakenName(cause)) {
        setError("name", { message: TAKEN_NAME_MESSAGE });
        setFocus("name");
      } else {
        showFormError(cause, NAME_FIELDS, toast, (field, message) => {
          setError(field, { message });
          setFocus(field);
        }, teamToastFor(cause), staleReloadOptions(cause));
      }
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-8">
      <Field
        label="Team name"
        autoComplete="organization"
        placeholder="Night Owls"
        maxLength={80}
        error={errors.name?.message}
        {...register("name")}
      />
      <div>
        <SubmitButton pending={pending} pendingLabel="Creating team" disabled={pending}>
          Create team
        </SubmitButton>
      </div>
    </form>
  );
}
