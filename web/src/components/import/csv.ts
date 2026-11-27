/**
 * A small RFC 4180 CSV parser with no dependencies. Shared by every import screen.
 *
 * - Fields may be wrapped in double quotes. Inside quotes, commas and line breaks are data.
 * - A doubled quote ("") inside a quoted field is one literal quote.
 * - Rows end with CRLF, LF or a bare CR. A final line break does not make an empty row.
 * - A leading byte order mark is dropped.
 */

export class CsvParseError extends Error {
  /** 1-based line on which the problem was found. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "CsvParseError";
    this.line = line;
  }
}

/** Parses CSV text into rows of string fields. Throws CsvParseError on an unclosed quoted field. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let fieldStartLine = 1;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (char === "\n") line += 1;
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      fieldStartLine = line;
      i += 1;
    } else if (char === ",") {
      endField();
      i += 1;
    } else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      i += 1;
      line += 1;
    } else {
      field += char;
      i += 1;
    }
  }

  if (inQuotes) {
    throw new CsvParseError("A quoted field is never closed.", fieldStartLine);
  }
  // Keep a last row only when it has content, so a trailing line break adds nothing.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Turns parsed rows into objects keyed by the header row (the first row). Header names are trimmed.
 * Fully blank rows are skipped. Missing cells become "", and extra cells are ignored.
 * `line` on each result is the 1-based line in the file (the header is line 1). Blank rows are skipped, so the
 * position in the returned array is not always the line. Imports number rows by their position in the array.
 */
export function rowsToObjects(rows: string[][]): Array<{ line: number; values: Record<string, string> }> {
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  const result: Array<{ line: number; values: Record<string, string> }> = [];

  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const values: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header === "") return;
      values[header] = cells[column] ?? "";
    });
    result.push({ line: index + 1, values });
  }
  return result;
}
