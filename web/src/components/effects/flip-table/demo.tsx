"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { DemoFrame } from "../demo-frame";
import { type FlipColumn, FlipTable } from "./flip-table";

type Team = { id: string; name: string; city: string; score: number; change: number };

const TEAMS: Team[] = [
  { id: "a", name: "North Star", city: "Lahore", score: 948, change: 12 },
  { id: "b", name: "Paper Tigers", city: "Karachi", score: 912, change: -4 },
  { id: "c", name: "Night Shift", city: "Islamabad", score: 887, change: 9 },
  { id: "d", name: "Second Draft", city: "Lahore", score: 861, change: 3 },
  { id: "e", name: "Good Enough", city: "Multan", score: 834, change: -7 },
  { id: "f", name: "Tiny Giants", city: "Karachi", score: 806, change: 15 },
  { id: "g", name: "Hello World", city: "Peshawar", score: 790, change: -2 },
  { id: "h", name: "Coffee Run", city: "Islamabad", score: 772, change: 6 },
];

const COLUMNS: FlipColumn<Team>[] = [
  { key: "name", label: "Team" },
  { key: "city", label: "City", optional: true },
  { key: "score", label: "Score", numeric: true },
  {
    key: "change",
    label: "Today",
    numeric: true,
    format: (value) => (Number(value) > 0 ? `+${value}` : String(value)),
  },
];

export default function Demo() {
  const reduced = useReducedMotion();
  const [teams, setTeams] = useState(TEAMS);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live || reduced) return;
    const timer = window.setInterval(() => {
      setTeams((current) => {
        const pick = Math.floor(Math.random() * current.length);
        const gain = Math.round(18 + Math.random() * 46);
        return current.map((team, index) =>
          index === pick ? { ...team, score: team.score + gain, change: team.change + gain } : team,
        );
      });
    }, 1300);
    return () => window.clearInterval(timer);
  }, [live, reduced]);

  return (
    <DemoFrame index="Data" title="Flip table" note="Sort any column, filter, or just watch: live scores reorder the rows without a single jump.">
      <div className="grid w-full justify-items-center gap-3">
        <FlipTable rows={teams} columns={COLUMNS} label="Team leaderboard" filterLabel="Filter by team or city" initialSort="score" />
        <button
          type="button"
          onClick={() => setLive((value) => !value)}
          className="cursor-pointer font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4"
        >
          {live ? "Pause live scores" : "Resume live scores"}
        </button>
      </div>
    </DemoFrame>
  );
}
