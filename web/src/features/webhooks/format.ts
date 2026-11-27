/** Shared display helpers for webhooks and share links. Only call these in effects or after data loads. */

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Not scheduled";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "Unknown" : dateTime.format(time);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "Unknown" : dateOnly.format(time);
}

const STATUS_LABELS: Record<string, string> = {
  succeeded: "Delivered",
  delivered: "Delivered",
  failed: "Failed",
  pending: "Pending",
  queued: "Pending",
  retrying: "Retrying",
  dead: "Gave up",
};

/** A word for a delivery status. Unknown statuses are shown as plain words, never as a code. */
export function deliveryStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  const known = STATUS_LABELS[status.toLowerCase()];
  if (known) return known;
  const spaced = status.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whether a delivery status counts as a failure, for the warning tone. */
export function isFailedStatus(status: string | null | undefined): boolean {
  return status === "failed" || status === "dead";
}
