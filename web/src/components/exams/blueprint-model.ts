import { ApiError } from "@/lib/api/client";
import type { Blueprint, BlueprintRow } from "@/lib/exam/types";

/** Shared rules for the fair-paper blueprint (5.2). They mirror the server checks in C13 so the form can explain a fault before a save. */
export const TOLERANCE_MIN = 0.01;
export const TOLERANCE_MAX = 0.3;
export const TOLERANCE_STEP = 0.01;
export const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;
/** A fairness score at or above this reads as fair (cobalt). Below it, amber. */
export const FAIR_THRESHOLD = 80;

/** One editable row. Counts and marks stay as typed text so partial input such as "2." survives a re-render. */
export type DraftRow = {
  key: string;
  topic: string;
  minDifficulty: number;
  maxDifficulty: number;
  count: string;
  marksEach: string;
};

export type DraftBlueprint = { enabled: boolean; tolerance: number; rows: DraftRow[] };

let rowSeq = 0;
export function newRowKey(): string {
  rowSeq += 1;
  return `blueprint-row-${rowSeq}`;
}

export function emptyRow(topic: string): DraftRow {
  return { key: newRowKey(), topic, minDifficulty: 1, maxDifficulty: 5, count: "1", marksEach: "1" };
}

export function toDraft(blueprint: Blueprint): DraftBlueprint {
  return {
    enabled: blueprint.enabled,
    tolerance: clampTolerance(blueprint.tolerance),
    rows: blueprint.rows.map((row) => ({
      key: newRowKey(),
      topic: row.topic,
      minDifficulty: row.minDifficulty,
      maxDifficulty: row.maxDifficulty,
      count: String(row.count),
      marksEach: String(row.marksEach),
    })),
  };
}

export function clampTolerance(value: number): number {
  if (!Number.isFinite(value)) return 0.05;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(TOLERANCE_MAX, Math.max(TOLERANCE_MIN, rounded));
}

/** Marks rounded to hundredths, so float noise never shows as a mismatch. */
export function sumMarks(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;
}

function parseCount(text: string): number {
  return Number(text.trim());
}

function parseMarks(text: string): number {
  return Number(text.trim());
}

/** Problems that block a save, keyed by row. The form-level list is `problems`. */
export type Validation = {
  rowIssues: Record<string, string>;
  problems: string[];
  /** Blueprint total minus the exam total. Zero when it matches. Shown as a warning, not a block. */
  totalDifference: number;
  blueprintTotal: number;
  canSave: boolean;
};

export function validateDraft(draft: DraftBlueprint, topics: readonly string[], examTotal: number): Validation {
  const rowIssues: Record<string, string> = {};
  const problems: string[] = [];

  // A switched-off blueprint keeps its rows but does not check them, so hidden rows never block a save.
  if (!draft.enabled) {
    return { rowIssues, problems, totalDifference: 0, blueprintTotal: 0, canSave: true };
  }

  for (const row of draft.rows) {
    const issue = rowIssue(row, topics);
    if (issue) rowIssues[row.key] = issue;
  }

  if (draft.enabled && draft.rows.length === 0) problems.push("Add at least one row before you save.");

  const blueprintTotal = sumMarks(
    draft.rows.map((row) => {
      const count = parseCount(row.count);
      const marks = parseMarks(row.marksEach);
      return Number.isInteger(count) && count > 0 && marks > 0 ? count * marks : 0;
    }),
  );
  const totalDifference = sumMarks([blueprintTotal, -examTotal]);

  return {
    rowIssues,
    problems,
    totalDifference,
    blueprintTotal,
    canSave: problems.length === 0 && Object.keys(rowIssues).length === 0,
  };
}

function rowIssue(row: DraftRow, topics: readonly string[]): string | null {
  if (row.topic === "") return "Choose a topic.";
  if (!topics.includes(row.topic)) return "This topic is not on the paper any more. Choose another.";
  if (row.minDifficulty > row.maxDifficulty) return "The lowest difficulty is above the highest.";
  const count = parseCount(row.count);
  if (!Number.isInteger(count) || count < 1) return "Count must be a whole number, 1 or more.";
  const marks = parseMarks(row.marksEach);
  if (!Number.isFinite(marks) || marks <= 0 || Math.round(marks * 4) !== marks * 4) {
    return "Marks each must be more than 0, in steps of 0.25.";
  }
  return null;
}

/** The body for PUT /exams/{id}/blueprint. Call only after validateDraft says canSave. */
export function toPayload(draft: DraftBlueprint): Blueprint {
  return {
    enabled: draft.enabled,
    tolerance: clampTolerance(draft.tolerance),
    rows: draft.rows.map(
      (row): BlueprintRow => ({
        topic: row.topic,
        minDifficulty: row.minDifficulty,
        maxDifficulty: row.maxDifficulty,
        count: parseCount(row.count),
        marksEach: parseMarks(row.marksEach),
      }),
    ),
  };
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function toleranceLabel(tolerance: number): string {
  return `±${Math.round(tolerance * 100)}% difficulty`;
}

export function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function scoreTone(score: number): "fair" | "uneven" {
  return score >= FAIR_THRESHOLD ? "fair" : "uneven";
}
