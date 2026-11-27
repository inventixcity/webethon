"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ErrorPage } from "@/components/errors/error-page";
import { Button } from "@/components/ui/button";
import { useScreenError } from "@/features/account/use-screen-error";
import { SettingsCard } from "@/features/account/components/settings-card";
import { useTeam } from "@/features/teams/hooks";
import { isAtLeast, ROLE_HELP, ROLE_LABEL } from "@/features/teams/types";
import { DangerZone } from "./danger-zone";
import { InvitesPanel } from "./invites-panel";
import { MembersPanel } from "./members-panel";
import { RenameTeamForm } from "./rename-team-form";
import { TeamSwitcher } from "./team-switcher";

/** One team: its name, people, invites and the leave and delete controls. */
export function TeamSettings({ teamId }: { teamId: string }) {
  const { team, loading, error, reload } = useTeam(teamId);
  const view = useScreenError(error);

  if (!team) {
    if (loading) {
      return <div aria-label="Loading team" className="h-40 motion-safe:animate-pulse border border-rule bg-paper-raised" />;
    }
    if (view?.kind === "page") {
      return (
        <ErrorPage
          code={view.page}
          requestId={view.requestId}
          retryAfterSeconds={view.retryAfterSeconds}
          onRetry={() => void reload()}
          as="div"
        />
      );
    }
    return (
      <div className="grid gap-4">
        <p role="alert" className="text-vermilion-deep">
          {view?.message}
        </p>
        <div className="flex flex-wrap gap-6">
          <Button type="button" variant="link" onClick={() => void reload()}>
            Try again
          </Button>
          <Button asChild variant="link">
            <Link href="/app/teams">Back to teams</Link>
          </Button>
        </div>
      </div>
    );
  }

  const canAdmin = isAtLeast(team.role, "admin");

  return (
    <div className="grid content-start gap-12">
      <section className="grid gap-6">
        <Link
          href="/app/teams"
          className="inline-flex w-fit items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase transition-colors duration-(--duration-fast) hover:text-vermilion-deep"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Teams
        </Link>
        <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          <span aria-hidden="true" className="size-1.5 bg-vermilion" />
          Your role: {ROLE_LABEL[team.role]} · {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
        </p>
        <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em] break-words">
          {team.name}
        </h1>
        <p className="max-w-xl text-ink-soft">{ROLE_HELP[team.role]}</p>
        <TeamSwitcher currentTeamId={team.id} />
      </section>

      <SettingsCard
        id="team-details"
        number="01"
        eyebrow="Details"
        title="Name"
        description="The name is shown to everyone on the team. The address stays the same if you rename it."
      >
        {canAdmin ? (
          <RenameTeamForm team={team} onSaved={() => void reload()} />
        ) : (
          <p className="text-lg break-words">{team.name}</p>
        )}
      </SettingsCard>

      <SettingsCard
        id="team-people"
        number="02"
        eyebrow="People"
        title="Members"
        description="Owners and admins can change roles and remove people. Admins can only give roles below their own."
      >
        <MembersPanel teamId={team.id} myRole={team.role} onChanged={() => void reload()} />
      </SettingsCard>

      {canAdmin && (
        <SettingsCard
          id="team-invites"
          number="03"
          eyebrow="Invites"
          title="Invite people"
          description="Each invite is a one-time link sent by email. It expires after seven days."
        >
          <InvitesPanel teamId={team.id} myRole={team.role} />
        </SettingsCard>
      )}

      <SettingsCard
        id="team-danger"
        number="04"
        eyebrow="Leave or delete"
        title="Danger zone"
        description="These actions change who can reach the team. Think before you confirm."
        tone="danger"
      >
        <DangerZone team={team} />
      </SettingsCard>
    </div>
  );
}
