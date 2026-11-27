"use client";

import { useState, type FormEvent } from "react";
import { deleteException, setException, type Exception } from "@/features/booking/client";
import { formFailure } from "@/features/data/errors";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { describeError } from "@/lib/errors";
import { Button } from "@/components/ui/button";

const timeClass =
  "h-12 w-full border border-rule bg-paper px-3 text-base text-ink outline-none focus-visible:border-ink disabled:opacity-40";

/** Long date for a "YYYY-MM-DD" key, read as a calendar day (not shifted by the viewer's zone). */
function longDate(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Dates that differ from the weekly hours: closed days, or one-off hours. Setting a date again
 * replaces the earlier entry.
 */
export function ExceptionsEditor({
  resourceId,
  exceptions,
  earliestDate,
  onChanged,
}: {
  resourceId: string;
  exceptions: Exception[];
  /** The first date that can be set (today in the resource's zone). */
  earliestDate: string;
  onChanged: () => void;
}) {
  const [date, setDate] = useState("");
  const [closed, setClosed] = useState(true);
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("12:00");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const toast = useToast();

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!date) problems.date = "Choose a date.";
    if (!closed && (!startTime || !endTime || endTime <= startTime)) {
      problems.endTime = "Closing time must be after opening time.";
    }
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      await setException(resourceId, date, closed ? { closed: true } : { closed: false, startTime, endTime });
      setDate("");
      setFieldErrors({});
      onChanged();
    } catch (caught) {
      // A field the server names gets its message beside it. Anything else is a toast.
      const failure = formFailure(caught, ["date", "startTime", "endTime"]);
      setFieldErrors(failure.named);
      if (failure.toast) toast.error(failure.toast);
    } finally {
      setBusy(false);
    }
  }

  async function remove(day: string) {
    try {
      await deleteException(resourceId, day);
      onChanged();
    } catch (caught) {
      toast.error(describeError(caught, { context: "action" }));
    }
  }

  return (
    <div className="grid gap-8">
      {exceptions.length === 0 ? (
        <p className="text-ink-muted">No special dates.</p>
      ) : (
        <ul className="grid divide-y divide-rule border-y border-ink">
          {exceptions.map((item) => (
            <li key={item.date} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="grid gap-1">
                <p className="font-medium">{longDate(item.date)}</p>
                <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
                  {item.closed ? "Closed" : `Open ${item.startTime} to ${item.endTime === "24:00" ? "midnight" : item.endTime}`}
                </p>
              </div>
              <Button
                type="button"
                variant="link" className="overflow-visible"
                onClick={() => void remove(item.date)}
                aria-label={`Remove special hours on ${item.date}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="grid gap-5 sm:max-w-xl" noValidate>
        <p className="font-mono text-xs tracking-[0.12em] uppercase">Add a special date</p>
        <div className="grid gap-2">
          <label htmlFor="exception-date" className="font-mono text-[11px] tracking-[0.08em] uppercase">
            Date
          </label>
          <input
            id="exception-date"
            type="date"
            min={earliestDate}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={timeClass}
            aria-invalid={Boolean(fieldErrors.date) || undefined}
            aria-describedby={fieldErrors.date ? "exception-date-error" : undefined}
          />
          <FieldError id="exception-date-error" message={fieldErrors.date} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={closed} onChange={(event) => setClosed(event.target.checked)} className="size-4 accent-ink" />
          Closed all day
        </label>
        {!closed && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 font-mono text-[11px] tracking-[0.08em] uppercase">
              Opens
              <input
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className={timeClass}
                aria-invalid={Boolean(fieldErrors.startTime) || undefined}
                aria-describedby={fieldErrors.startTime ? "exception-start-error" : undefined}
              />
              <FieldError id="exception-start-error" message={fieldErrors.startTime} />
            </label>
            <label className="grid gap-1 font-mono text-[11px] tracking-[0.08em] uppercase">
              Closes
              <input
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className={timeClass}
                aria-invalid={Boolean(fieldErrors.endTime) || undefined}
                aria-describedby={fieldErrors.endTime ? "exception-end-error" : undefined}
              />
              <FieldError id="exception-end-error" message={fieldErrors.endTime} />
            </label>
          </div>
        )}
        <div>
          <Button type="submit" loading={busy} disabled={busy}>
            {busy ? "Saving…" : "Save date"}
          </Button>
        </div>
      </form>
    </div>
  );
}
