"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { DemoFrame } from "../demo-frame";
import { KanbanBoard, type KanbanColumn, moveCard } from "./kanban-board";

const START: KanbanColumn[] = [
  {
    id: "todo",
    title: "To do",
    cards: [
      { id: "brief", title: "Write the launch brief", tag: "Planning" },
      { id: "pricing", title: "Agree the pricing page", tag: "Sales" },
      { id: "invite", title: "Invite the beta group", tag: "Community" },
    ],
  },
  {
    id: "doing",
    title: "Doing",
    cards: [
      { id: "signup", title: "Fix the sign-up flow", tag: "Product" },
      { id: "emails", title: "Draft the welcome emails", tag: "Marketing" },
    ],
  },
  {
    id: "done",
    title: "Done",
    cards: [{ id: "research", title: "Interview five customers", tag: "Research" }],
  },
];

export default function Demo() {
  const reduced = useReducedMotion();
  const [columns, setColumns] = useState(START);
  const [activity, setActivity] = useState("Sam is on this board with you");
  const latest = useRef(columns);
  const busy = useRef(false);

  useEffect(() => {
    latest.current = columns;
  }, [columns]);

  // A pretend teammate, so the board feels shared. It waits while you're holding a card.
  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => {
      if (busy.current) return;
      const board = latest.current;
      const from = board.findIndex((column) => column.cards.length > 1);
      const source = board[from];
      const card = source?.cards.at(-1);
      const target = board[(from + 1) % board.length];
      if (!card || !target) return;
      setColumns(moveCard(board, card, target.id, 0));
      setActivity(`Sam moved “${card.title}” to ${target.title}`);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [reduced]);

  return (
    <DemoFrame index="Data" title="Kanban board" note="Throw a card and it tilts with your hand. On a keyboard, focus a card and use the arrow keys.">
      <div className="grid w-full justify-items-center gap-4">
        <KanbanBoard
          columns={columns}
          onChange={setColumns}
          onDragChange={(dragging) => {
            busy.current = dragging;
          }}
        />
        <p aria-live="polite" className="flex items-center gap-2 font-mono text-[11px] tracking-[0.06em] text-ink-muted">
          <span className="size-2 bg-vermilion motion-safe:animate-pulse" />
          {activity}
        </p>
      </div>
    </DemoFrame>
  );
}
