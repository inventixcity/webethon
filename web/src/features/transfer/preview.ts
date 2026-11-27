/**
 * Reads just enough of a chosen file for the import preview. The server validates every row and is the authority;
 * this only counts the data rows and names the columns the collection doesn't have. The server's dry run reports
 * `created: 0` by design (nothing is written), so the preview's "ready" count comes from here.
 *
 * The column rules mirror backend/crates/transfer/src/lib.rs (parse_csv): export metadata columns are ignored, a
 * file written by the export has its `__transfer.data.` prefix removed, and `id`, `createdAt` and `updatedAt`
 * are ignored unless the collection has a field with that name.
 */

const EXPORT_META = new Set(["__transfer.meta.id", "__transfer.meta.createdAt", "__transfer.meta.updatedAt"]);
const DATA_PREFIX = "__transfer.data.";
const RESERVED_PLAIN = new Set(["id", "createdAt", "updatedAt"]);

export type FilePreviewFacts = {
  /** Data rows in the file, not counting a CSV header. Undefined when the file can't be read as rows. */
  rows: number | undefined;
  /** Columns the file has that this collection doesn't, named as the file wrote them. */
  unknownColumns: string[];
};

/** Counts the rows and finds unknown columns in a CSV or JSON file. Never throws: an unreadable file gives undefined rows. */
export async function readFilePreviewFacts(
  file: File,
  properties: Record<string, unknown>,
): Promise<FilePreviewFacts> {
  const text = (await file.text()).replace(/^﻿/, "");
  const isJson = file.name.toLowerCase().endsWith(".json");
  if (isJson) return { rows: jsonRowCount(text), unknownColumns: [] };
  return csvFacts(text, properties);
}

function jsonRowCount(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function csvFacts(text: string, properties: Record<string, unknown>): FilePreviewFacts {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { rows: 0, unknownColumns: [] };
  const header = records[0];
  const has = (name: string) => Object.prototype.hasOwnProperty.call(properties, name);

  const exported = ["__transfer.meta.id", "__transfer.meta.createdAt", "__transfer.meta.updatedAt"].every((name) =>
    header.includes(name),
  );
  const unknownColumns = header.filter((name) => {
    if (exported) {
      if (EXPORT_META.has(name)) return false;
      const plain = name.startsWith(DATA_PREFIX) ? name.slice(DATA_PREFIX.length) : name;
      return !has(plain);
    }
    if (has(name)) return false;
    return !RESERVED_PLAIN.has(name);
  });
  return { rows: records.length - 1, unknownColumns: [...new Set(unknownColumns)] };
}

/**
 * Splits CSV text into records. Handles quoted fields with commas, doubled quotes and line breaks inside quotes.
 * Blank lines are skipped, as the server's CSV reader skips them.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((item) => !(item.length === 1 && item[0] === ""));
}
