"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { staleReloadOptions } from "@/features/account/errors";
import { teamToastFor } from "@/features/teams/errors";
import { deleteTeam, removeMember } from "@/features/teams/client";
import { useCurrentUserId } from "@/features/teams/hooks";
import type { Team } from "@/features/teams/types";
import { ConfirmAction } from "./confirm-action";

/** Leave and delete. Owners can't leave, so they hand the team over first. */
export function DangerZone({ team }: { team: Team }) {
  const router = useRouter();
  const toast = useToast();
  const userId = useCurrentUserId();
  const [leaving, setLeaving] = useState(false);
  const isOwner = team.role === "owner";

  async function leave() {
    if (!userId) return;
    setLeaving(true);
    try {
      await removeMember(team.id, userId);
      router.push("/app/teams");
      router.refresh();
    } catch (cause) {
      toast.error(teamToastFor(cause), staleReloadOptions(cause));
      setLeaving(false);
    }
  }

  return (
    <div className="grid gap-12">
      <div className="grid max-w-xl gap-4">
        <p className="font-medium">Leave this team</p>
        {isOwner ? (
          <p className="text-ink-soft">
            Owners can&apos;t leave yet. Hand the team to another member first, using Make owner in the members list.
          </p>
        ) : (
          <div>
            <ConfirmAction
              label="Leave team"
              question="Leave this team? You'll need a new invite to come back."
              confirmLabel="Leave team"
              tone="danger"
              pending={leaving}
              disabled={!userId}
              onConfirm={leave}
            />
          </div>
        )}
      </div>

      {isOwner && <DeleteTeamForm team={team} />}
    </div>
  );
}

function DeleteTeamForm({ team }: { team: Team }) {
  const router = useRouter();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  // Typing the name stops a slip of the mouse from deleting a team.
  const confirmed = typed === team.name;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true);
    try {
      await deleteTeam(team.id);
      router.push("/app/teams");
      router.refresh();
    } catch (cause) {
      toast.error(teamToastFor(cause), staleReloadOptions(cause));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid max-w-xl gap-6">
      <p className="font-medium">Delete this team</p>
      <p className="text-ink-soft">
        Everyone loses access straight away, and open invites stop working. The team can&apos;t be restored from the app.
      </p>
      <Field
        label="Type the team name to confirm"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        disabled={pending}
        onChange={(event) => setTyped(event.target.value)}
        aria-describedby="delete-team-hint"
      />
      <p id="delete-team-hint" className="font-mono text-[11px] tracking-wide break-words text-ink-muted">
        Enter <span className="text-ink">{team.name}</span> exactly as shown.
      </p>
      <div>
        <SubmitButton variant="danger" pending={pending} pendingLabel="Deleting team" disabled={!confirmed || pending}>
          Delete team
        </SubmitButton>
      </div>
    </form>
  );
}
