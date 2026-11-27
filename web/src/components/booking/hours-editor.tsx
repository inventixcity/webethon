"use client";

import { useState } from "react";
import { setRules, type Rule } from "@/features/booking/client";
import { ApiError } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";

/** Monday first, as people read a week. The API numbers Sunday as 0. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Window = { start: string; end: string; untilMidnight: boolean };
type Days = Record<number, Window[]>;

function emptyDays(): Days {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

/** The API's "24:00" is shown as "until midnight", because a time input can't show it. */
function fromRules(rules: Rule[]): Days {
  const days = emptyDays();
  for (const rule of rules) {
    const untilMidnight = rule.endTime === "24:00";
    days[rule.weekday].push({ start: rule.startTime, end: untilMidnight ? "23:59" : rule.endTime, untilMidnight });
  }
  for (const weekday of ORDER) days[weekday].sort((a, b) => a.start.localeCompare(b.start));
  return days;
}

function toRules(days: Days): Rule[] {
  return ORDER.flatMap((weekday) =>
    days[weekday].map((window) => ({
      weekday,
      startTime: window.start,
      endTime: window.untilMidnight ? "24:00" : window.end,
    })),
  );
}

function minutes(value: string): number {
  if (value === "24:00") return 1440;
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

/** Problems the server would also reject, reported before a round trip. */
function problems(days: Days): string[] {
  const messages: string[] = [];
  for (const weekday of ORDER) {
    const name = NAMES[weekday];
    const windows = days[weekday];
    windows.forEach((window) => {
      if (!window.start) messages.push(`${name}: add an opening time.`);
      else if (!window.untilMidnight && window.end && minutes(window.end) <= minutes(window.start)) {
        messages.push(`${name}: closing time must be after opening time.`);
      }
    });
    const sorted = [...windows].sort((a, b) => minutes(a.start) - minutes(b.start));
    sorted.slice(1).forEach((window, index) => {
      const previous = sorted[index];
      const previousEnd = previous.untilMidnight ? 1440 : minutes(previous.end);
      if (minutes(window.start) < previousEnd) messages.push(`${name}: hours overlap.`);
    });
  }
  return messages;
}

/** Row keys ("weekday-index") in the order they are sent, so a server index can be placed on its row. */
function rowKeys(days: Days): string[] {
  return ORDER.flatMap((weekday) => days[weekday].map((_, index) => `${weekday}-${index}`));
}

/** The row a server path names, such as "rules.3.startTime". The first number in the path is the row. */
function rowFor(path: string, keys: string[]): string | undefined {
  const number = path.split(/[./]/).find((part) => /^\d+$/.test(part));
  return number === undefined ? undefined : keys[Number(number)];
}

/** A server message is shown only when it reads as plain text. */
function plainText(text: unknown): string {
  if (typeof text !== "string") return "Check these hours.";
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < 200 && !/[{}[\]]/.test(trimmed) ? trimmed : "Check these hours.";
}

const timeClass =
  "h-12 w-full border border-rule bg-paper px-3 text-base text-ink outline-none focus-visible:border-ink disabled:opacity-40";

/** The weekly opening hours. Saving replaces the whole week, so the list shown is the list kept. */
export function HoursEditor({
  resourceId,
  timezone,
  initial,
  onSaved,
}: {
  resourceId: string;
  timezone: string;
  initial: Rule[];
  onSaved: (rules: Rule[]) => void;
}) {
  const [days, setDays] = useState<Days>(() => fromRules(initial));
  const [busy, setBusy] = useState(false);
  // Server errors, by row key ("weekday-index"). Shown beside the row they are about.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  const issues = problems(days);

  function update(weekday: number, index: number, change: Partial<Window>) {
    setSaved(false);
    setRowErrors({});
    setDays((previous) => ({
      ...previous,
      [weekday]: previous[weekday].map((window, position) => (position === index ? { ...window, ...change } : window)),
    }));
  }

  function add(weekday: number) {
    setSaved(false);
    setDays((previous) => ({
      ...previous,
      [weekday]: [...previous[weekday], { start: "09:00", end: "17:00", untilMidnight: false }],
    }));
  }

  function remove(weekday: number, index: number) {
    setSaved(false);
    setDays((previous) => ({
      ...previous,
      [weekday]: previous[weekday].filter((_, position) => position !== index),
    }));
  }

  async function save() {
    if (busy || issues.length > 0) return;
    setBusy(true);
    setRowErrors({});
    setSaved(false);
    try {
      const rules = await setRules(resourceId, toRules(days));
      setDays(fromRules(rules));
      setSaved(true);
      onSaved(rules);
    } catch (caught) {
      // A detail that names a row goes beside that row. Anything else is a toast.
      const details = caught instanceof ApiError && Array.isArray(caught.details) ? caught.details : [];
      const keys = rowKeys(days);
      const mapped: Record<string, string> = {};
      let unplaced = details.length === 0;
      for (const detail of details) {
        const item = (detail ?? {}) as { path?: unknown; message?: unknown };
        const key = typeof item.path === "string" ? rowFor(item.path, keys) : undefined;
        if (key === undefined) unplaced = true;
        else mapped[key] ??= plainText(item.message);
      }
      setRowErrors(mapped);
      if (unplaced) toast.error(describeError(caught, { context: "action" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <p className="text-ink-muted">
        Hours are in {timezone}. Leave a day empty to close it. Windows on the same day can't overlap.
      </p>

      <div className="grid gap-px border-y border-ink bg-rule">
        {ORDER.map((weekday) => (
          <fieldset key={weekday} className="grid gap-4 bg-paper py-5 sm:grid-cols-[9rem_1fr]">
            <legend className="sr-only">{NAMES[weekday]}</legend>
            <p className="font-mono text-xs tracking-[0.12em] uppercase">{NAMES[weekday]}</p>
            <div className="grid min-w-0 gap-4">
              {days[weekday].length === 0 && <p className="text-ink-muted">Closed</p>}
              {days[weekday].map((window, index) => {
                const id = `${weekday}-${index}`;
                const rowError = rowErrors[id];
                return (
                  <div key={id} className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <label className="grid gap-1 font-mono text-[11px] tracking-[0.08em] uppercase">
                      Opens
                      <input
                        type="time"
                        value={window.start}
                        onChange={(event) => update(weekday, index, { start: event.target.value })}
                        className={timeClass}
                        aria-label={`${NAMES[weekday]} opens`}
                        aria-invalid={Boolean(rowError) || undefined}
                        aria-describedby={rowError ? `hours-${id}-error` : undefined}
                      />
                    </label>
                    <label className="grid gap-1 font-mono text-[11px] tracking-[0.08em] uppercase">
                      Closes
                      <input
                        type="time"
                        value={window.untilMidnight ? "" : window.end}
                        disabled={window.untilMidnight}
                        onChange={(event) => update(weekday, index, { end: event.target.value })}
                        className={timeClass}
                        aria-label={`${NAMES[weekday]} closes`}
                        aria-invalid={Boolean(rowError) || undefined}
                        aria-describedby={rowError ? `hours-${id}-error` : undefined}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={window.untilMidnight}
                          onChange={(event) => update(weekday, index, { untilMidnight: event.target.checked })}
                          className="size-4 accent-ink"
                        />
                        Until midnight
                      </label>
                      <Button
                        type="button"
                        variant="link" className="overflow-visible"
                        onClick={() => remove(weekday, index)}
                        aria-label={`Remove ${NAMES[weekday]} hours ${index + 1}`}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <FieldError id={`hours-${id}-error`} message={rowError} className="mt-0" />
                  </div>
                );
              })}
              <div>
                <Button type="button" variant="secondary" size="sm" onClick={() => add(weekday)}>
                  Add hours
                </Button>
              </div>
            </div>
          </fieldset>
        ))}
      </div>

      {issues.length > 0 && (
        <ul role="alert" className="grid gap-1 text-vermilion-deep">
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="button" loading={busy} disabled={busy || issues.length > 0} onClick={() => void save()}>
          {busy ? "Saving…" : "Save weekly hours"}
        </Button>
        <p aria-live="polite" className="font-mono text-xs tracking-[0.08em] text-ink-muted uppercase">
          {saved ? "Saved" : ""}
        </p>
      </div>
    </div>
  );
}
