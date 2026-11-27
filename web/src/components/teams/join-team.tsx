"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { teamToastFor } from "@/features/teams/errors";
import { acceptInvite } from "@/features/teams/client";
import { ROLE_LABEL, type Team } from "@/features/teams/types";
import type { ErrorView } from "@/lib/errors";

type JoinState =
  | { status: "working" }
  | { status: "done"; team: Team }
  | { status: "error"; view: ErrorView };

/**
 * Accepts an invite from its link. The token is read from the URL once, then removed from the address
 * bar and history, so it isn't left behind or shared by accident.
 */
export function JoinTeam({ token }: { token?: string }) {
  const [state, setState] = useState<JoinState>(() =>
    token
      ? { status: "working" }
      : {
          status: "error",
          view: {
            kind: "toast",
            title: "Invite link incomplete",
            message: "This link is missing its invite code. Ask for a new invite.",
            page: 404,
            code: "BAD_REQUEST",
          },
        },
  );
  const started = useRef(false);

  useEffect(() => {
    // Strict Mode runs effects twice in development. One request is enough, and a second would fail.
    if (!token || started.current) return;
    started.current = true;
    window.history.replaceState(null, "", "/app/teams/join");

    acceptInvite(token)
      .then((team) => setState({ status: "done", team }))
      .catch((cause: unknown) => setState({ status: "error", view: teamToastFor(cause, "invite") }));
  }, [token]);

  if (state.status === "working") {
    return (
      <p role="status" aria-live="polite" className="font-mono text-[11px] tracking-[0.12em] uppercase">
        Joining the team
      </p>
    );
  }

  if (state.status === "done") {
    const { team } = state;
    return (
      <section aria-labelledby="joined-title" className="grid max-w-xl gap-6">
        <h1 id="joined-title" className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em] break-words">
          You&apos;re in.
        </h1>
        <p className="text-ink-soft">
          You joined <span className="text-ink">{team.name}</span> as {ROLE_LABEL[team.role]}.
        </p>
        <div>
          <Button asChild>
            <Link href={`/app/teams/${encodeURIComponent(team.id)}`}>Open the team</Link>
          </Button>
        </div>
      </section>
    );
  }

  // This page is the result of the invite itself, so the reason is shown here as well as in a toast.
  const { view } = state;
  return (
    <section aria-labelledby="join-error-title" className="grid max-w-xl gap-6">
      <h1 id="join-error-title" className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em]">
        This invite didn&apos;t work.
      </h1>
      <p role="alert" className="text-vermilion-deep">
        {view.message}
      </p>
      {view.code === "NOT_FOUND" && <p className="text-ink-soft">Invites work once and expire after seven days.</p>}
      <div>
        <Button asChild variant="link">
          <Link href="/app/teams">Go to your teams</Link>
        </Button>
      </div>
    </section>
  );
}
