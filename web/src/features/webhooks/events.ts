/**
 * The events a webhook can subscribe to. Record events are per entity, so they are built from GET /entities.
 * The server enforces what the owner can read, so this list only offers choices.
 */

export const ALL_EVENTS = "*";

export type EventOption = { value: string; label: string };

export type EventGroup = {
  id: string;
  label: string;
  options: EventOption[];
};

export type EntityOption = { name: string; label: string };

const RECORD_ACTIONS: { action: "created" | "updated" | "deleted"; label: string }[] = [
  { action: "created", label: "Created" },
  { action: "updated", label: "Updated" },
  { action: "deleted", label: "Deleted" },
];

const OTHER_EVENTS: EventOption[] = [
  { value: "comment.created", label: "Comment created" },
  { value: "booking.created", label: "Booking created" },
  { value: "booking.cancelled", label: "Booking cancelled" },
  { value: "payment.completed", label: "Payment completed" },
  { value: "team.member_joined", label: "Team member joined" },
];

/** Groups for the checkbox picker: one row per entity, then the other events. */
export function eventGroups(entities: EntityOption[]): EventGroup[] {
  const records: EventGroup[] = entities.map((entity) => ({
    id: `entity-${entity.name}`,
    label: entity.label,
    options: RECORD_ACTIONS.map(({ action, label }) => ({
      value: `record.${action}:${entity.name}`,
      label,
    })),
  }));
  return [...records, { id: "other", label: "Other", options: OTHER_EVENTS }];
}

/**
 * "All events" is exclusive: choosing it clears the rest, and choosing anything else clears it.
 */
export function toggleEvent(selected: readonly string[], value: string, checked: boolean): string[] {
  if (value === ALL_EVENTS) return checked ? [ALL_EVENTS] : [];
  const without = selected.filter((item) => item !== ALL_EVENTS && item !== value);
  return checked ? [...without, value] : without;
}
