"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ALL_EVENTS, toggleEvent, type EventGroup } from "@/features/webhooks/events";

type EventPickerProps = {
  groups: EventGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** The field error for the events, when there is one. Shown next to the group of checkboxes. */
  error?: string;
};

/** Checkboxes for the webhook events, grouped by entity. Each group is a labelled set. */
export function EventPicker({ groups, selected, onChange, disabled = false, error }: EventPickerProps) {
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const allChecked = selected.includes(ALL_EVENTS);

  return (
    <fieldset aria-describedby={error ? errorId : undefined} className="grid gap-6">
      <legend className="mb-4 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Events</legend>

      <EventCheckbox
        id={`${baseId}-all`}
        label="All events"
        hint="Includes records of entities added later."
        checked={allChecked}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(toggleEvent(selected, ALL_EVENTS, checked))}
      />

      {groups.map((group) => (
        <div key={group.id} role="group" aria-label={group.label} className="grid gap-3 border-t border-rule pt-5">
          <p className="font-medium">{group.label}</p>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {group.options.map((option) => {
              const id = `${baseId}-${option.value.replace(/[^a-zA-Z0-9]+/g, "-")}`;
              return (
                <EventCheckbox
                  key={option.value}
                  id={id}
                  label={option.label}
                  checked={selected.includes(option.value)}
                  disabled={disabled || allChecked}
                  onCheckedChange={(checked) => onChange(toggleEvent(selected, option.value, checked))}
                />
              );
            })}
          </div>
        </div>
      ))}

      {error ? (
        <p id={errorId} role="alert" className="flex items-center gap-2 font-mono text-[11px] tracking-wide">
          <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function EventCheckbox({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(state) => onCheckedChange(state === true)}
        className="mt-0.5"
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="cursor-pointer text-[12px] normal-case tracking-normal font-medium">
          {label}
        </Label>
        {hint ? <span className="text-sm text-ink-muted">{hint}</span> : null}
      </div>
    </div>
  );
}
