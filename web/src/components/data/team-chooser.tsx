"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { listTeams } from "@/features/teams/client";
import type { Team } from "@/features/teams/types";
import { useLoadErrorToast } from "@/features/data/use-error-toast";

export function useTeamSelection() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const teamId = params.get("teamId");
  const [teams, setTeams] = useState<Team[]>([]);
  // A failed team list is a toast. The chooser stays usable with Personal.
  const [error, setError] = useState<unknown>(undefined);
  useLoadErrorToast(error);
  useEffect(() => { let active = true; listTeams().then(value => { if (active) { setError(undefined); setTeams(value); } }).catch(caught => { if (active) setError(caught); }); return () => { active = false; }; }, []);
  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("teamId", id); else next.delete("teamId");
    next.delete("record");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  return { teamId, teams, team: teams.find(team => team.id === teamId), error, select };
}
export function TeamChooser({ selection }: { selection: ReturnType<typeof useTeamSelection> }) {
  return <div className="grid gap-2 text-sm"><label className="grid gap-2">Workspace
    <select className="border border-rule bg-paper-raised px-3 py-2 text-ink" value={selection.teamId ?? ""} onChange={event => selection.select(event.target.value)}>
      <option value="">Personal</option>
      {selection.teamId && !selection.team && <option value={selection.teamId}>Selected team</option>}
      {selection.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
    </select></label>{selection.error !== undefined && <p role="status" className="text-ink-muted">Your teams didn&apos;t load. Showing Personal.</p>}</div>;
}
