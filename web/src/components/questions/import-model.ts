import type { ImportColumn } from "@/components/import/import-table";
import { parseCsv } from "@/components/import/csv";

/*
 * Question import: turns a CSV or JSON file into the rows the POST /questions/import endpoint takes, and builds
 * the preview table. The server is the authority on validity; this only shapes the data and names the columns.
 */

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 500;

export const CSV_COLUMNS = [
  "topic",
  "difficulty",
  "kind",
  "stem",
  "optionA",
  "optionB",
  "optionC",
  "optionD",
  "optionE",
  "optionF",
  "correct",
  "marks",
  "negativeMarks",
  "multiRule",
  "rubric",
  "maxWords",
  "explanation",
] as const;

/** Preview columns. Option columns cover A to F, which the flat CSV format supports. */
export const PREVIEW_COLUMNS: ImportColumn[] = [
  { key: "topic", label: "Topic" },
  { key: "difficulty", label: "Difficulty" },
  { key: "kind", label: "Kind" },
  { key: "stem", label: "Stem" },
  { key: "optionA", label: "Option A" },
  { key: "optionB", label: "Option B" },
  { key: "optionC", label: "Option C" },
  { key: "optionD", label: "Option D" },
  { key: "optionE", label: "Option E" },
  { key: "optionF", label: "Option F" },
  { key: "correct", label: "Correct" },
  { key: "marks", label: "Marks" },
  { key: "negativeMarks", label: "Negative" },
  { key: "multiRule", label: "Multi rule" },
  { key: "rubric", label: "Rubric" },
  { key: "maxWords", label: "Max words" },
  { key: "explanation", label: "Explanation" },
];

const OPTION_KEYS = ["optionA", "optionB", "optionC", "optionD", "optionE", "optionF"] as const;

/** A parsed file, ready to send. `rows` keeps file order, so row N here is row N for the server. */
export type ParsedImport = {
  format: "csv" | "json";
  rows: Array<Record<string, unknown>>;
};

export class ImportFileError extends Error {}

/** Header names match the canonical column names regardless of case or surrounding spaces. */
const CANONICAL = new Map<string, string>(CSV_COLUMNS.map((name) => [name.toLowerCase(), name]));

export function parseImportFile(text: string, fileName: string): ParsedImport {
  const lower = fileName.toLowerCase();
  const looksJson = lower.endsWith(".json") || text.trimStart().startsWith("[");
  if (looksJson) return parseJsonImport(text);
  return parseCsvImport(text);
}

function parseCsvImport(text: string): ParsedImport {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The file could not be read as CSV.";
    throw new ImportFileError(`${message} Check the quotes in the file.`);
  }
  if (rows.length < 2) throw new ImportFileError("The file needs a header row and at least one question.");

  // Column index -> canonical name. Unknown columns are ignored.
  const headerMap = new Map<number, string>();
  rows[0].forEach((header, index) => {
    const canonical = CANONICAL.get(header.trim().toLowerCase());
    if (canonical) headerMap.set(index, canonical);
  });
  const names = new Set(headerMap.values());
  if (!names.has("topic") || !names.has("stem") || !names.has("marks")) {
    throw new ImportFileError("The header row needs at least topic, stem, marks, kind, difficulty and correct.");
  }

  // Blank lines are dropped. The order of the rest is kept, so row N here is row N on the server.
  const data = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));
  const mapped = data.map((cells) => {
    const flat: Record<string, unknown> = {};
    headerMap.forEach((name, index) => {
      const value = (cells[index] ?? "").trim();
      if (value !== "") flat[name] = value;
    });
    return flat;
  });

  return { format: "csv", rows: mapped };
}

function parseJsonImport(text: string): ParsedImport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportFileError("This JSON file could not be read. Check that it is valid JSON.");
  }
  if (!Array.isArray(value)) throw new ImportFileError("The JSON file must hold an array of questions.");
  const rows = value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ImportFileError(`Item ${index + 1} is not a question object.`);
    }
    return item as Record<string, unknown>;
  });
  return { format: "json", rows };
}

/** Flattens any row (flat CSV or QuestionInput object) into the preview columns. Never throws. */
export function previewRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of PREVIEW_COLUMNS) out[column.key] = display(row[column.key]);

  const options = Array.isArray(row.options) ? row.options : [];
  options.slice(0, OPTION_KEYS.length).forEach((option, index) => {
    const text = typeof option === "object" && option !== null ? (option as { text?: unknown }).text : undefined;
    out[OPTION_KEYS[index]] = display(text);
  });
  if (Array.isArray(row.correct)) out.correct = row.correct.map(display).join(",");
  return out;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(display).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Maps a server error path to a preview column: `optionC` or `options[2].text` -> the option column,
 * `correct` -> correct, `marks` -> marks. Unknown paths highlight nothing.
 */
export function columnForImportPath(path: string): string | undefined {
  const option = /^options\[(\d+)\]/.exec(path);
  if (option) return OPTION_KEYS[Number(option[1])];
  const head = path.split(/[.[]/)[0];
  if ((OPTION_KEYS as readonly string[]).includes(head)) return head;
  return PREVIEW_COLUMNS.some((column) => column.key === head) ? head : undefined;
}
