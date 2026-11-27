import type { MultiRule, Question, QuestionInput, QuestionKind } from "@/lib/exam/types";

/*
 * Question form model: draft state, validation that mirrors the server rules (exam_questions), and the mapping
 * between the form, the API shapes and the candidate preview. No React in here.
 */

export const KIND_LABEL: Record<QuestionKind, string> = {
  single: "Single",
  multi: "Multi",
  written: "Written",
};

export const KINDS: QuestionKind[] = ["single", "multi", "written"];

export const MULTI_RULES: Array<{ value: MultiRule; label: string; explain: string }> = [
  {
    value: "all_or_nothing",
    label: "All or nothing",
    explain:
      "Full marks only if the candidate selects every correct option and nothing else. Any other selection scores zero.",
  },
  {
    value: "partial",
    label: "Partial credit",
    explain:
      "Each correct option chosen earns its share of the marks (correct options chosen out of all correct options). Choosing any wrong option scores zero.",
  },
  {
    value: "partial_penalty",
    label: "Partial with penalty",
    explain:
      "Each correct option chosen adds its share, and each wrong option chosen takes one share away. The total never goes below zero.",
  },
];

export const OPTION_LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;
export const MAX_OPTIONS = 10;
export const MIN_OPTIONS = 2;

export const LIMITS = {
  topicMax: 80,
  stemMax: 4000,
  optionTextMax: 500,
  rubricMax: 4000,
  explanationMax: 4000,
  marksMax: 1000,
  maxWordsMax: 5000,
} as const;

export type DraftOption = { id: string; text: string };

export type DraftState = {
  topic: string;
  difficulty: string;
  kind: QuestionKind;
  stem: string;
  options: DraftOption[];
  correct: string[];
  marks: string;
  negativeMarks: string;
  multiRule: MultiRule;
  rubric: string;
  maxWords: string;
  explanation: string;
};

/** Error messages keyed by form field. Option fields use `options.<index>.text`. */
export type FieldErrors = Record<string, string>;

export function emptyDraft(): DraftState {
  return {
    topic: "",
    difficulty: "3",
    kind: "single",
    stem: "",
    options: [
      { id: "a", text: "" },
      { id: "b", text: "" },
    ],
    correct: [],
    marks: "1",
    negativeMarks: "0",
    multiRule: "all_or_nothing",
    rubric: "",
    maxWords: "",
    explanation: "",
  };
}

export function draftFromQuestion(question: Question): DraftState {
  return {
    topic: question.topic,
    difficulty: String(question.difficulty),
    kind: question.kind,
    stem: question.stem,
    options: question.options.map((option) => ({ id: option.id, text: option.text })),
    correct: [...question.correct],
    marks: String(question.marks),
    negativeMarks: String(question.negativeMarks),
    multiRule: question.multiRule,
    rubric: question.rubric,
    maxWords: question.maxWords === null ? "" : String(question.maxWords),
    explanation: question.explanation,
  };
}

/** The first option letter not used yet, or null when all ten are taken. */
export function nextOptionId(options: DraftOption[]): string | null {
  const used = new Set(options.map((option) => option.id));
  return OPTION_LETTERS.find((letter) => !used.has(letter)) ?? null;
}

/** Marks move in 0.25 steps. The tolerance keeps float noise from causing a false error. */
function isQuarterStep(value: number): boolean {
  return Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Live validation. Returns an error for every field that is currently wrong. */
export function validateDraft(draft: DraftState): FieldErrors {
  const errors: FieldErrors = {};

  const topic = draft.topic.trim();
  if (topic === "") errors.topic = "Enter a topic.";
  else if (topic.length > LIMITS.topicMax) errors.topic = `Topic must be ${LIMITS.topicMax} characters or fewer.`;

  const difficulty = parseNumber(draft.difficulty);
  if (difficulty === null || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    errors.difficulty = "Choose a difficulty from 1 to 5.";
  }

  if (draft.stem.trim() === "") errors.stem = "Write the question text.";
  else if (draft.stem.trim().length > LIMITS.stemMax) {
    errors.stem = `Question text must be ${LIMITS.stemMax} characters or fewer.`;
  }

  const written = draft.kind === "written";
  if (!written) {
    if (draft.options.length < MIN_OPTIONS) errors.options = `Add at least ${MIN_OPTIONS} options.`;
    else if (draft.options.length > MAX_OPTIONS) errors.options = `Use at most ${MAX_OPTIONS} options.`;

    draft.options.forEach((option, index) => {
      const text = option.text.trim();
      if (text === "") errors[`options.${index}.text`] = "Enter the option text.";
      else if (text.length > LIMITS.optionTextMax) {
        errors[`options.${index}.text`] = `Option text must be ${LIMITS.optionTextMax} characters or fewer.`;
      }
    });

    const correctCount = draft.correct.length;
    if (draft.kind === "single" && correctCount !== 1) {
      errors.correct = "Mark exactly one correct option.";
    } else if (draft.kind === "multi" && correctCount < 1) {
      errors.correct = "Mark at least one correct option.";
    }
  }

  const marks = parseNumber(draft.marks);
  if (marks === null) errors.marks = "Enter the marks.";
  else if (marks <= 0) errors.marks = "Marks must be more than zero.";
  else if (marks > LIMITS.marksMax) errors.marks = `Marks must be ${LIMITS.marksMax} or fewer.`;
  else if (!isQuarterStep(marks)) errors.marks = "Marks move in steps of 0.25.";

  const negative = parseNumber(draft.negativeMarks);
  if (negative === null) errors.negativeMarks = "Enter 0 if there is no penalty.";
  else if (negative < 0) errors.negativeMarks = "Negative marks cannot be below zero.";
  else if (marks !== null && negative > marks) errors.negativeMarks = "Negative marks cannot exceed the marks.";

  if (written) {
    if (draft.rubric.length > LIMITS.rubricMax) errors.rubric = `Rubric must be ${LIMITS.rubricMax} characters or fewer.`;
    const words = draft.maxWords.trim();
    if (words !== "") {
      const value = Number(words);
      if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxWordsMax) {
        errors.maxWords = `Word limit must be a whole number from 1 to ${LIMITS.maxWordsMax}, or empty.`;
      }
    }
  }

  if (draft.explanation.length > LIMITS.explanationMax) {
    errors.explanation = `Explanation must be ${LIMITS.explanationMax} characters or fewer.`;
  }

  return errors;
}

/** Converts a valid draft into the QuestionInput the API expects. Call only when validateDraft returns no errors. */
export function draftToInput(draft: DraftState): QuestionInput {
  const written = draft.kind === "written";
  const validIds = new Set(draft.options.map((option) => option.id));
  return {
    topic: draft.topic.trim(),
    difficulty: Number(draft.difficulty) as QuestionInput["difficulty"],
    kind: draft.kind,
    stem: draft.stem.trim(),
    options: written ? [] : draft.options.map((option) => ({ id: option.id, text: option.text.trim() })),
    correct: written ? [] : draft.correct.filter((id) => validIds.has(id)),
    marks: Number(draft.marks),
    negativeMarks: Number(draft.negativeMarks),
    multiRule: draft.kind === "multi" ? draft.multiRule : "all_or_nothing",
    rubric: written ? draft.rubric.trim() : "",
    maxWords: written && draft.maxWords.trim() !== "" ? Number(draft.maxWords) : null,
    explanation: draft.explanation.trim(),
  };
}

const SIMPLE_FIELDS = [
  "topic",
  "difficulty",
  "kind",
  "stem",
  "marks",
  "negativeMarks",
  "multiRule",
  "rubric",
  "maxWords",
  "explanation",
] as const;

/**
 * Maps a server validation path (for example `options[2].text` or `marks`) to the form field that shows it.
 * Returns null for a path this form does not show; those errors go in the banner.
 */
export function fieldForServerPath(path: string): string | null {
  const option = /^options\[(\d+)\]/.exec(path);
  if (option) return `options.${option[1]}.text`;
  if (path === "options" || path === "correct") return path;
  if (/^correct\[\d*\]/.test(path)) return "correct";
  return (SIMPLE_FIELDS as readonly string[]).includes(path) ? path : null;
}

/** One line for the editor: how a multi question scores, with the share per correct option. */
export function scoringSummary(draft: DraftState): string {
  if (draft.kind === "written") return "Marked by an examiner against the rubric.";
  if (draft.kind === "single") return "Full marks for the correct option. Zero otherwise.";
  const rule = MULTI_RULES.find((item) => item.value === draft.multiRule)?.label ?? "";
  const marks = parseNumber(draft.marks);
  const correct = draft.correct.length;
  if (marks === null || marks <= 0 || correct === 0) return rule;
  return `${rule}. Each correct option is worth ${formatMarks(marks / correct)} marks.`;
}

export function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

export function formatObserved(question: Pick<Question, "observedFacility" | "observedCount">): string {
  if (question.observedFacility === null) return "No data yet";
  return `Observed: ${Math.round(question.observedFacility * 100)}% correct (n=${question.observedCount})`;
}

export function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
