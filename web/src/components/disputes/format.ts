import type { Dispute, DisputeResolution, DisputeStatus } from "@/lib/exam/types";

/** Limits mirror the server: a reason is 10 to 2000 characters, the examiner's response is up to 2000. */
export const DISPUTE_MIN_LENGTH = 10;
export const DISPUTE_MAX_LENGTH = 2000;
/** Regrades move in quarter marks. */
export const MARKS_STEP = 0.25;
/** A candidate can dispute within 7 days of results being published. */
export const DISPUTE_WINDOW_MS = 7 * 86_400_000;

export const STATUS_LABEL: Record<DisputeStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const RESOLUTION_LABEL: Record<DisputeResolution, string> = {
  none: "No change to marks",
  regrade: "Marks regraded",
  void_item: "Question voided for everyone",
  accept_alternative: "Alternative answer accepted",
};

/** Marks to two places, keeping one decimal when that is all there is: 14 is "14.0", 12.25 stays "12.25". */
export function formatMarks(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const fixed = value.toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

/** "Score 12.5 → 14.0", or null when the score did not move or is not known. */
export function scoreChangeText(before: number | null, after: number | null): string | null {
  if (before === null || after === null || before === after) return null;
  return `Score ${formatMarks(before)} → ${formatMarks(after)}`;
}

/** The score line for a dispute: the change when there was one, otherwise the unchanged score. */
export function scoreLine(dispute: Pick<Dispute, "scoreBefore" | "scoreAfter">): string {
  const change = scoreChangeText(dispute.scoreBefore, dispute.scoreAfter);
  if (change) return change;
  return dispute.scoreBefore === null ? "Score not recorded" : `Score ${formatMarks(dispute.scoreBefore)} (unchanged)`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** The moment the candidate's dispute window closes, from the result's publication time. */
export function disputeWindowEnd(publishedAt: string): number {
  return Date.parse(publishedAt) + DISPUTE_WINDOW_MS;
}

/** True when a value is a whole number of quarter marks. */
export function isQuarterStep(value: number): boolean {
  return Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
}
