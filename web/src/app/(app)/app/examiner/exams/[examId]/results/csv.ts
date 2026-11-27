import type { ResultRow } from "@/lib/exam/types";

/** Cells that a spreadsheet would read as a formula. A leading ' keeps them as text. */
const FORMULA_START = /^[\t\r\n ]*[=+\-@]/;

/** One CSV cell: formula-safe, then quoted when it holds a comma, quote or line break. */
export function csvCell(value: string): string {
  let text = value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const STATUS: Record<ResultRow["status"], string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Expired",
};
const GRADING: Record<ResultRow["gradingStatus"], string> = { pending: "Pending", partial: "Partial", complete: "Complete" };

const num = (value: number | null) => (value === null || !Number.isFinite(value) ? "" : String(Number(value.toFixed(2))));

/** The results table as CSV text, with a header row and CRLF line endings. */
export function resultsToCsv(rows: ResultRow[]): string {
  const header = [
    "Candidate",
    "Email",
    "Status",
    "Auto marks",
    "Manual marks",
    "Total marks",
    "Percent",
    "Result",
    "Grading",
    "Review priority",
    "Submitted at",
  ];
  const lines = rows.map((row) =>
    [
      row.displayName,
      row.email,
      STATUS[row.status],
      num(row.autoScore),
      num(row.manualScore),
      num(row.totalScore),
      row.percent === null ? "" : Number(row.percent.toFixed(1)).toString(),
      row.passed === null ? "" : row.passed ? "Pass" : "Fail",
      GRADING[row.gradingStatus],
      row.reviewPriority,
      row.submittedAt ?? "",
    ].map(csvCell).join(","),
  );
  return [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

/** Saves CSV text as a file through a temporary object URL. */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
