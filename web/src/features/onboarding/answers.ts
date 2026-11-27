/**
 * Pure helpers for the onboarding answers. The server checks everything again; these only keep the
 * screen from showing values the server would refuse.
 */

export const NOTIFICATION_VALUES = ["all", "important", "none"] as const;
export type Notifications = (typeof NOTIFICATION_VALUES)[number];

export type Answers = {
  interests?: string[];
  notifications?: Notifications;
};

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_INTERESTS = 12;

/** Keeps only the answers the server accepts, in the shape it expects. Anything else is dropped. */
export function sanitizeAnswers(raw: unknown): Answers {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const answers: Answers = {};
  const interests = source.interests;
  if (Array.isArray(interests)) {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const item of interests) {
      if (typeof item === "string" && SLUG.test(item) && !seen.has(item) && clean.length < MAX_INTERESTS) {
        seen.add(item);
        clean.push(item);
      }
    }
    answers.interests = clean;
  }
  const notifications = source.notifications;
  if (typeof notifications === "string" && (NOTIFICATION_VALUES as readonly string[]).includes(notifications)) {
    answers.notifications = notifications as Notifications;
  }
  return answers;
}

/** Adds or removes one interest. A full set refuses new ones and returns the list unchanged. */
export function toggleInterest(current: string[] | undefined, value: string, max = MAX_INTERESTS): string[] {
  const list = current ?? [];
  if (list.includes(value)) return list.filter((item) => item !== value);
  if (list.length >= max) return list;
  return [...list, value];
}

/** 0 at the first step, 1 at the last, clamped in between. */
export function progressFor(index: number, total: number): number {
  if (total <= 1) return 1;
  return Math.min(1, Math.max(0, index / (total - 1)));
}

/** How many questions have an answer. Drives the signal on the welcome screen. */
export function answeredCount(answers: Answers): number {
  return (answers.interests?.length ?? 0) + (answers.notifications ? 1 : 0);
}

export type ProfileDraft = { displayName: string; avatarUrl: string };

/** The profile step's rules: a name of 1 to 120 characters, and an avatar that is empty or https. */
export function checkProfile(draft: ProfileDraft): { displayName?: string; avatarUrl?: string } {
  const errors: { displayName?: string; avatarUrl?: string } = {};
  const name = draft.displayName.trim();
  if (!name) errors.displayName = "Add the name you want to be called.";
  else if (name.length > 120) errors.displayName = "Use at most 120 characters.";
  const avatar = draft.avatarUrl.trim();
  if (avatar && !isHttps(avatar)) errors.avatarUrl = "Use a full link that starts with https://";
  return errors;
}

function isHttps(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
