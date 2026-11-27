"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { Slot } from "@/features/booking/client";
import { dayLabel, formatInstant, timeKey, type WeekGrid } from "@/features/booking/time";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  grid: WeekGrid;
  /** The zone the times are shown in: the viewer's. */
  zone: string;
  onPick: (slot: Slot) => void;
  /** Accessible name for the calendar. */
  label: string;
  className?: string;
};

function seatsText(seats: number): string {
  return seats === 1 ? "1 seat left" : `${seats} seats left`;
}

/**
 * A week of slots. On wide screens it is a grid you can drive with the arrow keys (one tab stop,
 * Home and End jump along a row). On phones it becomes a day picker and a list of that day's times.
 * Both views are always rendered and CSS shows one, so assistive tech only sees the one in use.
 */
export function SlotCalendar({ grid, zone, onPick, label, className }: Props) {
  return (
    <div className={cn("min-w-0", className)}>
      <WeekGridView grid={grid} zone={zone} onPick={onPick} label={label} />
      <DayList grid={grid} zone={zone} onPick={onPick} />
    </div>
  );
}

function WeekGridView({ grid, zone, onPick, label }: Omit<Props, "className">) {
  const [focus, setFocus] = useState({ row: 0, column: 0 });
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const rows = grid.times.length;
  const columns = grid.days.length;

  function focusCell(row: number, column: number) {
    const next = {
      row: Math.min(Math.max(row, 0), rows - 1),
      column: Math.min(Math.max(column, 0), columns - 1),
    };
    setFocus(next);
    buttons.current.get(`${next.row}:${next.column}`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (rows === 0) return;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [focus.row, focus.column - 1],
      ArrowRight: [focus.row, focus.column + 1],
      ArrowUp: [focus.row - 1, focus.column],
      ArrowDown: [focus.row + 1, focus.column],
      Home: [focus.row, 0],
      End: [focus.row, columns - 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    focusCell(move[0], move[1]);
  }

  const template = { gridTemplateColumns: `4.5rem repeat(${columns}, minmax(0, 1fr))` };

  return (
    <div
      role="grid"
      aria-label={label}
      aria-rowcount={rows + 1}
      aria-colcount={columns + 1}
      onKeyDown={onKeyDown}
      className="hidden overflow-x-auto md:block"
    >
      <div role="row" className="grid min-w-[44rem] border-b border-ink" style={template}>
        <div role="columnheader" className="sr-only">
          Time
        </div>
        {grid.days.map((day) => (
          <div
            role="columnheader"
            key={day.key}
            className="px-2 py-3 font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase"
          >
            {dayLabel(day.date)}
          </div>
        ))}
      </div>
      {grid.times.map((time, row) => (
        <div role="row" key={time} className="grid min-w-[44rem] border-b border-rule" style={template}>
          <div role="rowheader" className="px-2 py-3 font-mono text-xs text-ink-muted">
            {time}
          </div>
          {grid.cells[row].map((cell, column) => {
            const focused = focus.row === row && focus.column === column;
            const day = dayLabel(grid.days[column].date);
            const available = cell.slot !== null;
            return (
              <div role="gridcell" key={cell.dayKey} className="border-l border-rule p-1">
                <button
                  type="button"
                  ref={(node) => {
                    const key = `${row}:${column}`;
                    if (node) buttons.current.set(key, node);
                    else buttons.current.delete(key);
                  }}
                  tabIndex={focused ? 0 : -1}
                  onFocus={() => setFocus({ row, column })}
                  aria-disabled={available ? undefined : true}
                  aria-label={
                    cell.slot
                      ? `${formatInstant(cell.slot.startsAt, zone)}, ${seatsText(cell.slot.seatsLeft)}`
                      : `${day} ${time}: not available`
                  }
                  onClick={() => {
                    if (cell.slot) onPick(cell.slot);
                  }}
                  className={cn(
                    "flex h-12 w-full items-center justify-center font-mono text-[11px] tracking-[0.08em] uppercase transition-colors duration-(--duration-fast) ease-(--ease-enter)",
                    available
                      ? "border border-ink text-ink hover:bg-ink hover:text-paper"
                      : "cursor-default border border-transparent text-ink-muted/40",
                  )}
                >
                  {cell.slot ? (cell.slot.seatsLeft === 1 ? "Open" : `${cell.slot.seatsLeft} left`) : ""}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {rows === 0 && <p className="py-10 text-ink-muted">No open times this week.</p>}
    </div>
  );
}

function DayList({ grid, zone, onPick }: Omit<Props, "className" | "label">) {
  const columns = grid.days.length;
  const firstOpen = grid.days.findIndex((_, column) => grid.cells.some((row) => row[column]?.slot));
  const [selected, setSelected] = useState(Math.max(firstOpen, 0));
  const day = grid.days[Math.min(selected, columns - 1)];
  const items = grid.times.flatMap((time, row) => {
    const slot = grid.cells[row]?.[selected]?.slot;
    return slot ? [{ time, slot }] : [];
  });

  if (!day) return null;

  return (
    <div className="md:hidden">
      <div role="group" aria-label="Choose a day" className="grid grid-cols-7 border-y border-ink">
        {grid.days.map((item, index) => {
          const active = index === selected;
          const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(item.date);
          const number = new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(item.date);
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              onClick={() => setSelected(index)}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-2 font-mono text-[10px] tracking-[0.08em] uppercase",
                active ? "bg-ink text-paper" : "text-ink-muted",
              )}
            >
              <span>{weekday}</span>
              <span className="font-sans text-sm normal-case">{number}</span>
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="mt-4 font-mono text-xs tracking-widest text-ink-muted uppercase">
        {new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(day.date)}
      </p>
      {items.length === 0 ? (
        <p className="mt-4 text-ink-muted">No open times on this day.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {items.map(({ time, slot }) => {
            const end = timeKey(new Date(slot.endsAt), zone);
            return (
              <li key={slot.startsAt}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onPick(slot)}
                  aria-label={`${time} to ${end}, ${seatsText(slot.seatsLeft)}`}
                  className="h-auto min-h-12 w-full justify-between gap-4 px-4 py-3 text-left whitespace-normal"
                >
                  <span className="font-mono text-sm">
                    {time} – {end}
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.08em] uppercase">{seatsText(slot.seatsLeft)}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
