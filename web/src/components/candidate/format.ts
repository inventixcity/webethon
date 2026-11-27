import { ApiError } from "@/lib/api/client";
import type { CandidateExamCard } from "@/lib/exam/types";

const GENERIC = "Something went wrong. Please try again.";

let dateTime: Intl.DateTimeFormat | undefined;
let clock: Intl.DateTimeFormat | undefined;

/** Short date and time in the visitor's own locale and time zone. */
export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Unknown";
  dateTime ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return dateTime.format(at);
}

export function formatClock(ms: number): string {
  clock ??= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return clock.format(new Date(ms));
}

export function formatWindow(startsAt: string, endsAt: string): string {
  return `${formatDateTime(startsAt)} to ${formatDateTime(endsAt)}`;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Counts down to a moment in ms. Under a day it reads as hh:mm:ss, otherwise as days and hours. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} d ${String(hours).padStart(2, "0")} h ${String(minutes).padStart(2, "0")} m`;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export const ACCESS_LABEL: Record<CandidateExamCard["access"], string> = {
  upcoming: "Upcoming",
  available: "Open now",
  in_progress: "In progress",
  submitted: "Submitted",
  missed: "Missed",
  results: "Results ready",
};

/** Turns any thrown value into a sentence a candidate can read. Server messages are already written for people. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "This exam isn't available to you.";
    if (error.message) return error.message;
  }
  return GENERIC;
}
