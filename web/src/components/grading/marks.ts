/** Client-side marks rules. The server checks the same things again (0 to max, 0.25 steps). */

export const MARKS_STEP = 0.25;
export const FEEDBACK_MAX = 4000;

export type MarksCheck = { ok: true; value: number } | { ok: false; message: string };

/** Parses a marks entry. It must be a number from 0 to `max` in steps of 0.25. */
export function checkMarks(raw: string, max: number): MarksCheck {
  const text = raw.trim();
  if (text === "") return { ok: false, message: "Enter marks, or use a quick button." };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: "Marks must be a number." };
  if (value < 0) return { ok: false, message: "Marks cannot be negative." };
  if (value > max) return { ok: false, message: `Marks cannot be more than ${max}.` };
  const steps = value / MARKS_STEP;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    return { ok: false, message: "Use steps of 0.25, for example 2.5." };
  }
  return { ok: true, value };
}

/** Half marks, rounded down to the nearest 0.25 step. */
export function halfMarks(max: number): number {
  return Math.floor((max / 2) * 4) / 4;
}
