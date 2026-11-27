import { ApiError } from "@/lib/api/client";
import { messageFor } from "@/lib/errors";

/** Display helpers shared by the examiner monitor, grading, results and analytics screens. */

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pad = (value: number) => String(value).padStart(2, "0");

/** A percentage such as "62.5%". Pass digits for decimal places. */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  return isNumber(value) ? `${value.toFixed(digits)}%` : "—";
}

/** Marks rounded to 2 dp with no trailing zeros, for example 4.5 or 3. */
export function formatMarks(value: number | null | undefined): string {
  return isNumber(value) ? String(Number(value.toFixed(2))) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Clock text for a remaining time in milliseconds, for example 1:02:05 or 04:09. Never negative. */
export function formatClock(ms: number): string {
  if (!isNumber(ms) || ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Plain-language length in seconds, for example "45s", "2m" or "2m 10s". */
export function formatSeconds(seconds: number): string {
  if (!isNumber(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Short age for a past moment in milliseconds, for example "3s", "4m" or "2h". */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** A person-readable message for any failure. */
export function messageOf(error: unknown): string {
  return messageFor(error);
}

/** The `reason` of a 409 conflict, for example "published". Undefined for anything else. */
export function conflictReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const details = error.details;
  if (typeof details === "object" && details !== null && "reason" in details && typeof details.reason === "string") {
    return details.reason;
  }
  return undefined;
}
