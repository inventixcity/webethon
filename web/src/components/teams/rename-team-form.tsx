"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { Feedback } from "@/features/account/components/feedback";
import { showFormError, staleReloadOptions } from "@/features/account/errors";
import { renameTeam } from "@/features/teams/client";
import { isTakenName, TAKEN_NAME_MESSAGE, teamToastFor } from "@/features/teams/errors";
import { teamNameSchema, type TeamNameValues } from "@/features/teams/schemas";
import type { Team } from "@/features/teams/types";

const NAME_FIELDS = ["name"] as const;

type RenameTeamFormProps = {
  team: Team;
  /** Called after a save so the page can reload the team. */
  onSaved: () => void;
};

export function RenameTeamForm({ team, onSaved }: RenameTeamFormProps) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<TeamNameValues>({
    resolver: zodResolver(teamNameSchema),
    defaultValues: { name: team.name },
    mode: "onTouched",
  });

  async function onSubmit(values: TeamNameValues) {
    setPending(true);
    setNotice(undefined);
    try {
      await renameTeam(team.id, values.name);
      reset({ name: values.name });
      setNotice("Name saved.");
      onSaved();
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
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-6">
      <Field
        label="Team name"
        maxLength={80}
        error={errors.name?.message}
        {...register("name")}
      />
      <Feedback message={notice} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Saving" disabled={pending || !isDirty}>
          Save name
        </SubmitButton>
      </div>
    </form>
  );
}
