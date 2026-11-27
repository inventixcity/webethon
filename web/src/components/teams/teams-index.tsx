"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ErrorPage } from "@/components/errors/error-page";
import { Button } from "@/components/ui/button";
import { useScreenError } from "@/features/account/use-screen-error";
import { useTeams } from "@/features/teams/hooks";
import { ROLE_LABEL } from "@/features/teams/types";
import { CreateTeamForm } from "./create-team-form";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The teams page: the signed-in person's teams, and a form to start a new one. */
export function TeamsIndex() {
  const { teams, loading, error, reload } = useTeams();
  const view = useScreenError(error);

  if (view?.kind === "page" && teams.length === 0) {
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
    <>
      <section className="grid gap-6">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">01 / Your teams</p>

        {loading && teams.length === 0 && (
          <div aria-label="Loading teams" className="grid gap-3">
            {[1, 2].map((item) => (
              <div key={item} className="h-20 motion-safe:animate-pulse border border-rule bg-paper-raised" />
            ))}
          </div>
        )}

        {!!view && (
          <p role="alert" className="text-vermilion-deep">
            {view.message}{" "}
            <Button type="button" variant="link" onClick={() => void reload()}>
              Try again
            </Button>
          </p>
        )}

        {!loading && !error && teams.length === 0 && (
          <p className="text-ink-soft">You&apos;re not on a team yet. Create one below, or accept an invite from a link.</p>
        )}

        {teams.length > 0 && (
          <ul className="grid gap-3">
            {teams.map((team) => (
              <li key={team.id}>
                <Link
                  href={`/app/teams/${encodeURIComponent(team.id)}`}
                  className="group grid min-w-0 gap-4 border border-rule bg-paper-raised p-5 transition-colors duration-(--duration-fast) hover:border-ink sm:grid-cols-[1fr_auto] sm:items-center sm:p-6"
                >
                  <span className="grid min-w-0 gap-2">
                    <span className="min-w-0 text-2xl leading-tight font-medium tracking-[-0.02em] break-words">
                      {team.name}
                    </span>
                    <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                      {ROLE_LABEL[team.role]} · {team.memberCount} {team.memberCount === 1 ? "member" : "members"} ·
                      since {dateFormat.format(new Date(team.createdAt))}
                    </span>
                  </span>
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-5 shrink-0 transition-transform duration-(--duration-fast) group-hover:translate-x-1 group-hover:-translate-y-1"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-6 border-t border-ink pt-10">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">02 / New team</p>
        <h2 className="text-3xl leading-none font-medium tracking-[-0.03em]">Start a team.</h2>
        <CreateTeamForm />
        <Button type="button" variant="link" className="w-fit" onClick={() => void reload()}>
          Refresh the list
        </Button>
      </section>
    </>
  );
}
