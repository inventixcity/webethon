import { ApiError } from "@/lib/api/client";
import type { ExamPhase, ExamSettings, ExamStatus } from "@/lib/exam/types";

/** Fired on window after any change to an exam, so the header and open tabs reload. */
export const EXAM_CHANGED_EVENT = "invigil:exam-changed";

export const PHASE_LABEL: Record<ExamPhase, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  ongoing: "Ongoing",
  closed: "Closed",
  completed: "Completed",
  archived: "Archived",
};

export const STATUS_LABEL: Record<ExamStatus, string> = {
  draft: "Draft",
  published: "Published",
  completed: "Completed",
  archived: "Archived",
};

/** Defaults match the server defaults in exam_authoring (C2). */
export const DEFAULT_SETTINGS: ExamSettings = {
  shuffleQuestions: true,
  shuffleOptions: true,
  allowOfflineJournal: true,
  lateJoinMinutes: null,
  showBreakdown: true,
  integrity: { watermark: true, canary: false, fullscreen: true },
};

export function notifyExamChanged(examId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(EXAM_CHANGED_EVENT, { detail: examId }));
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatWindow(startsAt: string, endsAt: string): string {
  return `${formatDateTime(startsAt)} to ${formatDateTime(endsAt)}`;
}

/** Whole minutes between two ISO instants, or 0 when either is invalid. */
export function windowMinutes(startsAt: string, endsAt: string): number {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.floor((end - start) / 60000);
}

/** A UTC ISO string to the value a datetime-local input shows, in the viewer's local time. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value (the examiner's local time) to a UTC ISO string, or null when it is not a date. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Maps VALIDATION_FAILED details ({path, message}) to a path-keyed message map. */
export function fieldErrorsFrom(cause: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(cause instanceof ApiError) || !Array.isArray(cause.details)) return out;
  for (const item of cause.details) {
    if (typeof item !== "object" || item === null) continue;
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof path === "string" && typeof message === "string" && out[path] === undefined) out[path] = message;
  }
  return out;
}

export function isNotFound(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.code === "NOT_FOUND");
}

export function isConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409;
}

/** Non-negative whole number text, or null. */
export function parseWhole(value: string): number | null {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** Non-negative number with at most two decimals, or null. */
export function parseMarks(value: string): number | null {
  const trimmed = value.trim();
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : null;
}
