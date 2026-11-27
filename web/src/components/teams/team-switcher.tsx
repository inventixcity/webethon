"use client";

import { useRouter } from "next/navigation";
import { useTeams } from "@/features/teams/hooks";
import { SelectField } from "./select-field";

/** Jumps between the teams the person belongs to. Works from the keyboard and with screen readers. */
export function TeamSwitcher({ currentTeamId }: { currentTeamId?: string }) {
  const router = useRouter();
  const { teams, loading } = useTeams();

  return (
    <SelectField
      label="Switch team"
      className="max-w-xs"
      value={currentTeamId ?? ""}
      disabled={loading && teams.length === 0}
      onChange={(event) => {
        if (event.target.value) router.push(`/app/teams/${encodeURIComponent(event.target.value)}`);
      }}
    >
      <option value="" disabled>
        {loading && teams.length === 0 ? "Loading teams" : "Choose a team"}
      </option>
      {teams.map((team) => (
        <option key={team.id} value={team.id}>
          {team.name}
        </option>
      ))}
    </SelectField>
  );
}
