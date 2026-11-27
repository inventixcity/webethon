import type { AnswerResponse, Announcement, AttemptPayload, QuestionKind, SaveAnswerInput } from "@/lib/exam/types";

/**
 * The view model the workspace components consume. `useAttempt` (C5) must return a value that satisfies
 * `AttemptView`; the workspace container is the only place that calls the hook.
 */
export type AnswerState = "saved" | "saving" | "queued" | "offline" | "error";
export type SaveState = "saved" | "saving" | "offline" | "syncing" | "error";
/** Same values as `useNetworkStatus().quality` in `@/lib/exam/network`. */
export type NetworkQuality = "good" | "unstable" | "offline";
export type Typing = NonNullable<SaveAnswerInput["typing"]>;

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
  closed: boolean;
  deviceActive: boolean;
  takeover: () => Promise<void>;
  submit: () => Promise<void>;
  announcements: Announcement[];
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

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats the remaining time. mm:ss below an hour, hh:mm:ss from one hour up. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return total >= 3600
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

export function kindHint(kind: QuestionKind, maxWords: number | null): string {
  if (kind === "single") return "Choose one";
  if (kind === "multi") return "Choose all that apply";
  return maxWords === null ? "Written answer" : `Written answer, max ${maxWords} words`;
}

export const MULTI_RULE_LABEL: Record<AttemptPayload["items"][number]["multiRule"], string> = {
  all_or_nothing: "All or nothing",
  partial: "Partial credit",
  partial_penalty: "Partial credit with penalty",
};

export function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}
