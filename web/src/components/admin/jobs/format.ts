/** A timestamp for a person, or a dash when there is none or it doesn't parse. */
export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "—" : time.toLocaleString();
}

/** Plain text cut at `max` characters, with an ellipsis. Never returns markup. */
export function truncate(value: string | null, max: number): string {
  if (!value) return "None";
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}
