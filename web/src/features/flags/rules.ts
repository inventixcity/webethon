/** Client-side rules for the flag editor. The server validates again; these give people a field error first. */

export const FLAG_KEY_PATTERN = /^[a-z0-9.-]+$/;
export const FLAG_KEY_MESSAGE = "Use lowercase letters, digits, dots and dashes only.";

export const VALUE_MAX_BYTES = 8 * 1024;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidFlagKey(key: string): boolean {
  return FLAG_KEY_PATTERN.test(key);
}

/** Rollout is a whole number from 0 to 100. */
export function parseRollout(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * Splits a comma- or line-separated list. Items are trimmed, empty items are dropped, and duplicates
 * are removed. `identity` decides what counts as a duplicate (emails ignore case, team ids do not).
 */
export function parseList(text: string, identity: (item: string) => string = (item) => item): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const item = raw.trim();
    if (item === "") continue;
    const id = identity(item);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(item);
  }
  return items;
}

/** Email lists: duplicates are the same address in any case. */
export function parseEmails(text: string): string[] {
  return parseList(text, (item) => item.toLowerCase());
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

export type ValueResult =
  | { ok: true; value: unknown; present: boolean }
  | { ok: false; message: string };

/**
 * The value is JSON, at most 8 KB. Blank means "no value". The text is never echoed back in an error,
 * because it can be long and parser messages can quote it.
 */
export function parseValue(text: string): ValueResult {
  if (text.trim() === "") return { ok: true, value: undefined, present: false };
  if (new TextEncoder().encode(text).length > VALUE_MAX_BYTES) {
    return { ok: false, message: "The value is over 8 KB. Make it smaller." };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, present: true };
  } catch {
    return { ok: false, message: "The value isn't valid JSON. Check brackets, quotes and commas." };
  }
}
