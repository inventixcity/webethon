"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/features/account/components/feedback";
import { messageFor, staleReloadOptions } from "@/features/account/errors";
import { removeMember, setMemberRole, transferTeam } from "@/features/teams/client";
import { teamToastFor } from "@/features/teams/errors";
import { useMembers } from "@/features/teams/hooks";
import {
  assignableRoles,
  isAtLeast,
  ROLE_LABEL,
  type AssignableRole,
  type Member,
  type TeamRole,
} from "@/features/teams/types";
import { ConfirmAction } from "./confirm-action";
import { SelectField } from "./select-field";

type MembersPanelProps = {
  teamId: string;
  /** The signed-in person's role. Controls which actions appear; the API enforces them anyway. */
  myRole: TeamRole;
  /** Called after a change, so the page can refresh counts or the caller's own role. */
  onChanged: () => void;
};

export function MembersPanel({ teamId, myRole, onChanged }: MembersPanelProps) {
  const toast = useToast();
  const { members, hasMore, loading, loadingMore, error, reload, loadMore } = useMembers(teamId);
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  // A failed "Load more" keeps the list on screen, so it is shown as a toast.
  useEffect(() => {
    if (error && members.length > 0) toast.error(teamToastFor(error), staleReloadOptions(error));
  }, [error, members.length, toast]);

  const canManage = isAtLeast(myRole, "admin");
  const roleOptions = assignableRoles(myRole);

  /** Runs one change, then refreshes. Never throws: a failure is a toast. */
  async function run(member: Member, action: () => Promise<unknown>, done: string) {
    setBusyId(member.userId);
    setNotice(undefined);
    try {
      await action();
      setNotice(done);
      await reload();
      onChanged();
    } catch (cause) {
      toast.error(teamToastFor(cause), staleReloadOptions(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  if (loading && members.length === 0) {
    return <div aria-label="Loading members" className="h-32 motion-safe:animate-pulse border border-rule bg-paper" />;
  }

  if (error && members.length === 0) {
    return (
      <p role="alert" className="text-vermilion-deep">
        {messageFor(error)}{" "}
        <Button type="button" variant="link" onClick={() => void reload()}>
          Try again
        </Button>
      </p>
    );
  }

  return (
    <div className="grid gap-6">
      <ul aria-label="Members" className="grid">
        {members.map((member) => {
          const name = member.displayName || member.email || "Member";
          const isBusy = busyId === member.userId;
          // Owners are changed only by transfer. Everyone else is editable when their role is within reach.
          const editable = canManage && member.role !== "owner" && isAtLeast(myRole, member.role);
          const canMakeOwner = myRole === "owner" && member.role !== "owner";

          return (
            <li
              key={member.userId}
              className="grid gap-4 border-b border-rule py-5 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="font-medium break-words">{name}</p>
                {member.email && (
                  <p className="font-mono text-[11px] tracking-wide break-all text-ink-muted">{member.email}</p>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {editable ? (
                  <SelectField
                    label={`Role for ${name}`}
                    hideLabel
                    className="w-36"
                    value={member.role}
                    disabled={isBusy}
                    onChange={(event) => {
                      const next = event.target.value as AssignableRole;
                      void run(member, () => setMemberRole(teamId, member.userId, next), `${name} is now ${ROLE_LABEL[next]}.`);
                    }}
                  >
                    {roleOptions.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <span className="font-mono text-xs tracking-[0.12em] uppercase">{ROLE_LABEL[member.role]}</span>
                )}

                {canMakeOwner && (
                  <ConfirmAction
                    label="Make owner"
                    question={`Hand the team to ${name}? You'll become an admin.`}
                    confirmLabel="Make owner"
                    pending={isBusy}
                    onConfirm={() =>
                      run(member, () => transferTeam(teamId, member.userId), `${name} now owns the team. You're an admin.`)
                    }
                  />
                )}

                {editable && (
                  <ConfirmAction
                    label="Remove"
                    question={`Remove ${name} from the team?`}
                    confirmLabel="Remove"
                    tone="danger"
                    pending={isBusy}
                    onConfirm={() => run(member, () => removeMember(teamId, member.userId), `${name} was removed.`)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div>
          <Button type="button" variant="secondary" size="sm" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading" : "Load more"}
          </Button>
        </div>
      )}

      <Feedback message={notice} />
    </div>
  );
}
