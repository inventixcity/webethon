"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  createResource,
  updateResource,
  type Resource,
  type ResourceInput,
  type Visibility,
} from "@/features/booking/client";
import { browserZone, zoneOptions } from "@/features/booking/time";
import { formFailure } from "@/features/data/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";

type Props = {
  /** Omit to create a new resource. */
  resource?: Resource;
  onSaved: (resource: Resource) => void;
  submitLabel: string;
};

type Values = {
  name: string;
  description: string;
  timezone: string;
  slotMinutes: string;
  capacity: string;
  visibility: Visibility;
};

const FIELDS = ["name", "description", "timezone", "slotMinutes", "capacity", "visibility"] as const;

const selectClass =
  "h-12 w-full border border-rule bg-paper px-3 text-base text-ink outline-none focus-visible:border-ink";

export function ResourceForm({ resource, onSaved, submitLabel }: Props) {
  const [values, setValues] = useState<Values>({
    name: resource?.name ?? "",
    description: resource?.description ?? "",
    // Filled in after mount, so the server and the browser render the same first frame.
    timezone: resource?.timezone ?? "",
    slotMinutes: String(resource?.slotMinutes ?? 60),
    capacity: String(resource?.capacity ?? 1),
    visibility: resource?.visibility ?? "private",
  });
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const toast = useToast();

  useEffect(() => {
    if (!resource) setValues((previous) => (previous.timezone ? previous : { ...previous, timezone: browserZone() }));
  }, [resource]);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
    // Editing a field clears its message.
    setFieldErrors((previous) => {
      if (previous[key] === undefined) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    const input: ResourceInput = {
      name: values.name.trim(),
      description: values.description.trim(),
      timezone: values.timezone.trim(),
      slotMinutes: Number(values.slotMinutes),
      capacity: Number(values.capacity),
      visibility: values.visibility,
    };
    try {
      const saved = resource ? await updateResource(resource.id, input) : await createResource(input);
      onSaved(saved);
    } catch (caught) {
      // A field the server names gets its message beside it. Anything else is a toast.
      const failure = formFailure(caught, FIELDS);
      setFieldErrors(failure.named);
      if (failure.toast) toast.error(failure.toast);
    } finally {
      setBusy(false);
    }
  }

  const zones = zoneOptions(values.timezone);

  return (
    <form className="grid gap-7" onSubmit={submit} noValidate>
      <div className="grid gap-2">
        <Label htmlFor="resource-name">Name</Label>
        <Input
          id="resource-name"
          maxLength={120}
          value={values.name}
          aria-invalid={Boolean(fieldErrors.name) || undefined}
          aria-describedby={fieldErrors.name ? "resource-name-error" : undefined}
          onChange={(event) => set("name", event.target.value)}
          required
        />
        <FieldError id="resource-name-error" message={fieldErrors.name} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="resource-description">Description</Label>
        <textarea
          id="resource-description"
          rows={3}
          maxLength={2000}
          value={values.description}
          aria-invalid={Boolean(fieldErrors.description) || undefined}
          aria-describedby={fieldErrors.description ? "resource-description-error" : undefined}
          onChange={(event) => set("description", event.target.value)}
          className="w-full border border-rule bg-paper px-3 py-2 text-base text-ink outline-none focus-visible:border-ink"
        />
        <FieldError id="resource-description-error" message={fieldErrors.description} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="resource-timezone">Time zone</Label>
        <Input
          id="resource-timezone"
          list="resource-timezone-options"
          autoComplete="off"
          value={values.timezone}
          aria-invalid={Boolean(fieldErrors.timezone) || undefined}
          aria-describedby={fieldErrors.timezone ? "resource-timezone-error" : undefined}
          onChange={(event) => set("timezone", event.target.value)}
          required
        />
        <datalist id="resource-timezone-options">
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="text-sm text-ink-muted">Hours are kept in this zone, so a 09:00 slot stays at 09:00 here all year.</p>
        <FieldError id="resource-timezone-error" message={fieldErrors.timezone} />
      </div>

      <div className="grid gap-7 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor="resource-slot">Slot length (minutes)</Label>
          <Input
            id="resource-slot"
            type="number"
            inputMode="numeric"
            min={5}
            max={480}
            step={5}
            value={values.slotMinutes}
            aria-invalid={Boolean(fieldErrors.slotMinutes) || undefined}
            aria-describedby={fieldErrors.slotMinutes ? "resource-slot-error" : undefined}
            onChange={(event) => set("slotMinutes", event.target.value)}
          />
          <FieldError id="resource-slot-error" message={fieldErrors.slotMinutes} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="resource-capacity">Seats per slot</Label>
          <Input
            id="resource-capacity"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            value={values.capacity}
            aria-invalid={Boolean(fieldErrors.capacity) || undefined}
            aria-describedby={fieldErrors.capacity ? "resource-capacity-error" : undefined}
            onChange={(event) => set("capacity", event.target.value)}
          />
          <FieldError id="resource-capacity-error" message={fieldErrors.capacity} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="resource-visibility">Who can see it</Label>
          <select
            id="resource-visibility"
            value={values.visibility}
            aria-invalid={Boolean(fieldErrors.visibility) || undefined}
            aria-describedby={fieldErrors.visibility ? "resource-visibility-error" : undefined}
            onChange={(event) => set("visibility", event.target.value as Visibility)}
            className={selectClass}
          >
            <option value="private">Only me</option>
            <option value="public">Everyone signed in</option>
          </select>
          <FieldError id="resource-visibility-error" message={fieldErrors.visibility} />
        </div>
      </div>

      <div>
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
