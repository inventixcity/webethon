"use client";

import type { ImportRowError } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

/**
 * Lists import validation errors, grouped by row. Works for any import (questions, candidates).
 * Rows are numbered the way the server numbers them: row 1 is the first data row.
 */
export function ImportErrors({
  errors,
  rowLabel = (row) => `Row ${row}`,
  className,
}: {
  errors: ImportRowError[];
  /** Turns a row number into its heading. Defaults to "Row N". */
  rowLabel?: (row: number) => string;
  className?: string;
}) {
  if (errors.length === 0) return null;

  const groups = new Map<number, ImportRowError[]>();
  for (const error of errors) {
    const list = groups.get(error.row) ?? [];
    list.push(error);
    groups.set(error.row, list);
  }
  const rows = [...groups.keys()].sort((a, b) => a - b);

  return (
    <section
      aria-labelledby="import-errors-heading"
      className={cn("border border-vermilion-deep bg-paper-raised p-5", className)}
    >
      <h3 id="import-errors-heading" className="font-mono text-[11px] tracking-[0.14em] text-vermilion-deep uppercase">
        {errors.length} {errors.length === 1 ? "problem" : "problems"} in {rows.length}{" "}
        {rows.length === 1 ? "row" : "rows"}. Nothing has been imported.
      </h3>
      <ul className="mt-4 grid gap-4">
        {rows.map((row) => (
          <li key={row} className="grid gap-2 border-t border-rule pt-4">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink uppercase">{rowLabel(row)}</p>
            <ul className="grid gap-1.5">
              {groups.get(row)?.map((error, index) => (
                <li key={`${error.path}-${index}`} className="font-sans text-sm text-ink-soft">
                  <span className="font-mono text-[11px] text-vermilion-deep">{error.path || "row"}</span>
                  <span className="text-ink-muted"> · </span>
                  {error.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
