"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { useToast } from "@/components/feedback/toaster";
import { Feedback } from "@/features/account/components/feedback";
import { messageFor, showFormError, staleReloadOptions } from "@/features/account/errors";
import { createInvite, revokeInvite } from "@/features/teams/client";
import { teamToastFor } from "@/features/teams/errors";
import { useInvites } from "@/features/teams/hooks";
import { inviteSchema, type InviteValues } from "@/features/teams/schemas";
import { assignableRoles, ROLE_LABEL, type TeamRole } from "@/features/teams/types";
import { ConfirmAction } from "./confirm-action";
import { SelectField } from "./select-field";

const INVITE_FIELDS = ["email", "role"] as const;
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

type InvitesPanelProps = {
  teamId: string;
  myRole: TeamRole;
};

/** Sends invites and lists the ones still open. Only admins and owners see this panel. */
export function InvitesPanel({ teamId, myRole }: InvitesPanelProps) {
  const toast = useToast();
  const { invites, loading, error, reload } = useInvites(teamId);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [revokingId, setRevokingId] = useState<string>();
  const roleOptions = assignableRoles(myRole);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
    mode: "onTouched",
  });

  async function onSubmit(values: InviteValues) {
    setPending(true);
    setNotice(undefined);
    try {
      await createInvite(teamId, values.email, values.role);
      reset({ email: "", role: values.role });
      setNotice(`Invite sent to ${values.email}. The link works once and expires in 7 days.`);
      await reload();
    } catch (cause) {
      showFormError(cause, INVITE_FIELDS, toast, (field, message) => {
        setError(field, { message });
        setFocus(field);
      }, teamToastFor(cause), staleReloadOptions(cause));
    } finally {
      setPending(false);
    }
  }

  async function revoke(inviteId: string, email: string) {
    setRevokingId(inviteId);
    setNotice(undefined);
    try {
      await revokeInvite(teamId, inviteId);
      setNotice(`The invite for ${email} was revoked.`);
      await reload();
    } catch (cause) {
      toast.error(teamToastFor(cause, "invite"), staleReloadOptions(cause));
    } finally {
      setRevokingId(undefined);
    }
  }

  return (
    <div className="grid gap-10">
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
        <Field
          label="Email to invite"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="name@example.com"
          error={errors.email?.message}
          {...register("email")}
        />
        <SelectField label="Role" error={errors.role?.message} {...register("role")}>
          {roleOptions.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </SelectField>
        <div className="sm:col-span-2">
          <SubmitButton pending={pending} pendingLabel="Sending invite" disabled={pending}>
            Send invite
          </SubmitButton>
        </div>
      </form>

      <Feedback message={notice} />

      <div className="grid gap-4">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Open invites</p>
        {loading && invites.length === 0 && <div aria-label="Loading invites" className="h-16 motion-safe:animate-pulse bg-paper" />}
        {!!error && invites.length === 0 && (
          <p role="alert" className="text-vermilion-deep">
            {messageFor(error)}
          </p>
        )}
        {!loading && !error && invites.length === 0 && <p className="text-ink-soft">No open invites.</p>}
        {invites.length > 0 && (
          <ul aria-label="Open invites" className="grid">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="grid gap-3 border-b border-rule py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="break-all">{invite.email}</p>
                  <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    {ROLE_LABEL[invite.role]} · expires {dateFormat.format(new Date(invite.expiresAt))}
                  </p>
                </div>
                <ConfirmAction
                  label="Revoke"
                  question={`Revoke the invite for ${invite.email}?`}
                  confirmLabel="Revoke invite"
                  tone="danger"
                  pending={revokingId === invite.id}
                  onConfirm={() => revoke(invite.id, invite.email)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
