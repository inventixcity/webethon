/**
 * Time helpers for the booking screens. Instants come from the API in UTC. The viewer sees them in
 * their own time zone; each resource also has its own zone, which is shown next to it.
 *
 * Week arithmetic uses local calendar days (the viewer's zone). Zone-specific keys come from Intl,
 * so they are correct across daylight-saving changes.
 */
import type { Slot } from "./client";

const parts = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${zone}|${JSON.stringify(options)}`;
  let formatter = parts.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options });
    parts.set(cacheKey, formatter);
  }
  return formatter;
}

function part(instant: Date, zone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of partsFormatter(zone, options).formatToParts(instant)) {
    result[item.type] = item.value;
  }
  return result;
}

/** The viewer's own time zone, as the browser reports it. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** "2030-03-31": the calendar date of an instant on the wall clock in `zone`. */
export function dateKey(instant: Date, zone: string): string {
  const value = part(instant, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${value.year}-${value.month}-${value.day}`;
}

/** "09:30": the wall-clock time of an instant in `zone`, on a 24-hour clock. */
export function timeKey(instant: Date, zone: string): string {
  const value = part(instant, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${value.hour}:${value.minute}`;
}

/** Adds whole days to a "YYYY-MM-DD" key, without any time-zone effects. */
export function addDaysToKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Midnight at the start of the local day that contains `day`. Monday starts the week. */
export function startOfWeek(day: Date): Date {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** Local midnight `days` days after `day`. Uses calendar arithmetic, so it is correct across DST. */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/**
 * The resource-zone dates to ask the API for, so every slot that falls inside the viewer's week is
 * included. Padded by a day each side because a viewer's day can straddle two of the zone's days.
 */
export function zoneDateRange(weekStart: Date, zone: string): { from: string; to: string } {
  const weekEnd = addDays(weekStart, 7);
  const last = new Date(weekEnd.getTime() - 1);
  return {
    from: addDaysToKey(dateKey(weekStart, zone), -1),
    to: addDaysToKey(dateKey(last, zone), 1),
  };
}

export type GridCell = { dayKey: string; time: string; slot: Slot | null };

export type WeekGrid = {
  days: { key: string; date: Date }[];
  /** Times of day in the viewer's zone, as "HH:MM", in order. */
  times: string[];
  /** cells[row][column]: row follows `times`, column follows `days`. */
  cells: GridCell[][];
  /** Slots that fall inside the week, for counting. */
  count: number;
};

/**
 * Lays the slots out as a week grid in the viewer's zone. A slot that falls on a repeated hour
 * (clocks going back) takes the first cell, and the second is left empty.
 */
export function buildWeekGrid(slots: Slot[], weekStart: Date, zone: string): WeekGrid {
  const days = weekDays(weekStart).map((date) => ({ key: dateKey(date, zone), date }));
  const weekEnd = addDays(weekStart, 7);
  const byCell = new Map<string, Slot>();
  const times = new Set<string>();
  let count = 0;
  for (const slot of slots) {
    const start = new Date(slot.startsAt);
    if (start < weekStart || start >= weekEnd) continue;
    const dayKey = dateKey(start, zone);
    const time = timeKey(start, zone);
    const cell = `${dayKey}|${time}`;
    if (!byCell.has(cell)) byCell.set(cell, slot);
    times.add(time);
    count += 1;
  }
  const ordered = [...times].sort();
  const cells = ordered.map((time) =>
    days.map((day) => ({ dayKey: day.key, time, slot: byCell.get(`${day.key}|${time}`) ?? null })),
  );
  return { days: days.map(({ key, date }) => ({ key, date })), times: ordered, cells, count };
}

/** Readable instant in a zone, e.g. "Sat, 30 Mar 2030, 09:00 GMT". */
export function formatInstant(iso: string, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** Short day label for a column header, e.g. "Mon 4". */
export function dayLabel(day: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(day);
}

/** Heading for a week, e.g. "4 – 10 Mar 2030". */
export function weekTitle(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const start = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(weekStart);
  const last = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(end);
  return `${start} – ${last}`;
}

/** Time zone choices for the resource form. Falls back to a short list where Intl can't list them. */
export function zoneOptions(current?: string): string[] {
  const supported = Intl.supportedValuesOf?.("timeZone") ?? [
    "UTC",
    "Europe/London",
    "Europe/Paris",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
  const list = current && !supported.includes(current) ? [current, ...supported] : supported;
  return list;
}
