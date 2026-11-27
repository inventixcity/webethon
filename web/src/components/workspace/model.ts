import type { AnswerResponse, Announcement, AttemptPayload, JournalSyncResult, QuestionKind, SaveAnswerInput } from "@/lib/exam/types";

/**
 * The view model the workspace components consume. `useAttempt` (S2, `@/lib/exam/use-attempt`) must return a
 * value that satisfies `AttemptView`; the workspace container is the only place that calls the hook, and it
 * assigns the result to this type, so a contract drift fails `pnpm typecheck` here first.
 */
export type AnswerState = "saved" | "saving" | "queued" | "offline" | "error";
export type SaveState = "saved" | "saving" | "offline" | "syncing" | "error";
/** Same values as `useNetworkStatus().quality` in `@/lib/exam/network`. */
export type NetworkQuality = "good" | "unstable" | "offline";
export type Typing = NonNullable<SaveAnswerInput["typing"]>;
export type JournalRejectReason = JournalSyncResult["rejected"][number]["reason"];

export type AnswerEntry = { response: AnswerResponse; flagged: boolean; state: AnswerState };
export type AnswerMap = Record<string, AnswerEntry>;

export type AttemptView = {
  status: "loading" | "ready" | "error";
  error: unknown;
  payload: AttemptPayload | null;
  answers: AnswerMap;
  setAnswer: (itemId: string, response: AnswerResponse, typing?: Typing) => void;
  toggleFlag: (itemId: string) => void;
  saveState: SaveState;
  pendingCount: number;
  remainingMs: number;
  deadlineAt: string | null;
  closed: boolean;
  deviceActive: boolean;
  takeover: () => Promise<void>;
  submit: () => Promise<void>;
  announcements: Announcement[];
  /**
   * Optional, requested from S2: offline journal entries the server refused, kept for explanation. Read behind a
   * feature check; until it exists the workspace falls back to the "Journal sync rejected: ..." error text.
   */
  journalRejected?: Array<{ seq: number; itemId: string; reason: JournalRejectReason }>;
};

export function isSelectedResponse(response: AnswerResponse): response is { selected: string[] } {
  return "selected" in response;
}

/** An answer counts as answered only when it holds something a marker could read. */
export function isAnswered(response: AnswerResponse | undefined): boolean {
  if (!response) return false;
  if (isSelectedResponse(response)) return response.selected.length > 0;
  return response.text.trim().length > 0;
}

export function emptyResponse(kind: QuestionKind): AnswerResponse {
  return kind === "written" ? { text: "" } : { selected: [] };
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** The server refuses written answers above 20 000 characters, or 12 characters per allowed word. */
export function maxChars(maxWords: number | null): number {
  return maxWords !== null && maxWords > 0 ? Math.min(20_000, maxWords * 12) : 20_000;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats the remaining time. mm:ss up to an hour, h:mm:ss above it. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return total > 3600 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(Math.floor(total / 60))}:${pad2(seconds)}`;
}

/** Spoken form for the timer's accessible name, e.g. "1 hour 4 minutes". */
export function speakRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (!hours && minutes < 5) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ") || "0 seconds";
}

export function kindHint(kind: QuestionKind, maxWords: number | null): string {
  if (kind === "single") return "Choose one";
  if (kind === "multi") return "Choose all that apply";
  return maxWords === null ? "Written answer" : `Written answer · up to ${maxWords} words`;
}

export const MULTI_RULE_LABEL: Record<AttemptPayload["items"][number]["multiRule"], string> = {
  all_or_nothing: "All or nothing",
  partial: "Partial credit",
  partial_penalty: "Partial credit, wrong picks deduct",
};

export function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

/**
 * The engine marks an answer `queued` when it went to the on-device journal. Journal entries are deleted only
 * after the server acknowledges them, so once the journal is empty every queued answer is on the server, even
 * if the engine has not re-reported the item (a heartbeat-driven sync does not).
 */
export function effectiveState(state: AnswerState, pendingCount: number): AnswerState {
  if ((state === "queued" || state === "offline") && pendingCount === 0) return "saved";
  return state;
}

export type SaveSummary = {
  state: SaveState;
  /** Distinct questions waiting on this device. */
  queued: number;
  saving: number;
  /** Distinct questions whose last save failed. */
  failed: string[];
};

/**
 * The top-bar save state, derived from per-question states and the connection rather than the hook's single
 * flag, so the pill never claims "Offline" after a sync or "Error" for an offline submit attempt.
 */
export function summarizeSaves(answers: AnswerMap, pendingCount: number, offline: boolean, submitting: boolean): SaveSummary {
  let queued = 0;
  let saving = 0;
  const failed: string[] = [];
  for (const [itemId, entry] of Object.entries(answers)) {
    const state = effectiveState(entry.state, pendingCount);
    if (state === "queued" || state === "offline") queued += 1;
    else if (state === "saving") saving += 1;
    else if (state === "error") failed.push(itemId);
  }
  const state: SaveState = failed.length
    ? "error"
    : offline
      ? "offline"
      : queued > 0 || submitting
        ? "syncing"
        : saving > 0
          ? "saving"
          : "saved";
  return { state, queued, saving, failed };
}

/** Plain-language reasons for journal entries the server refused (5.3). */
export const REJECT_REASON: Record<JournalRejectReason, string> = {
  late: "written after your deadline, so it cannot count",
  closed: "arrived after the grace period that follows the deadline",
  lease: "its time proof could not be verified (this happens after a very long time offline, or if the device clock was changed)",
  future: "its timestamp was ahead of the server clock, which usually means the device clock was changed",
  chain: "the on-device record was out of order or had been altered",
  stale: "the server already holds a newer version of that answer",
};

/** Parses the engine's fallback error text, "Journal sync rejected: late, chain". */
export function parseRejectedReasons(error: unknown): JournalRejectReason[] {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const match = /Journal sync rejected:\s*(.+)$/i.exec(message);
  if (!match) return [];
  const known = Object.keys(REJECT_REASON) as JournalRejectReason[];
  return [...new Set(match[1].split(/\s*,\s*/))].filter((reason): reason is JournalRejectReason =>
    (known as string[]).includes(reason),
  );
}
