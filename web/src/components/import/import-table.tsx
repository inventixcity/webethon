"use client";

import type { ImportRowError } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

export type ImportColumn = { key: string; label: string };

/**
 * A preview of parsed import rows. Cells that a server error points at are marked, so the person can
 * see which value to fix. `columnForPath` maps an error path (for example `options[2].text`) to a column key.
 * The table scrolls sideways inside its own box, so the page itself never scrolls sideways.
 */
export function ImportTable({
  columns,
  rows,
  errors = [],
  columnForPath,
  caption,
  className,
}: {
  columns: ImportColumn[];
  /** Each row keyed by column key. Position + 1 is the row number the server uses. */
  rows: Array<Record<string, string>>;
  errors?: ImportRowError[];
  columnForPath?: (path: string) => string | undefined;
  caption: string;
  className?: string;
}) {
  const marked = new Map<string, ImportRowError>();
  if (columnForPath) {
    for (const error of errors) {
      const column = columnForPath(error.path);
      if (column) marked.set(`${error.row}:${column}`, error);
    }
  }

  return (
    <div className={cn("overflow-x-auto border border-ink bg-paper-raised", className)} tabIndex={0}>
      <table className="w-full min-w-max border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-ink">
            <th scope="col" className="px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
              Row
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowNumber = index + 1;
            return (
              <tr key={rowNumber} className="border-b border-rule align-top">
                <th scope="row" className="px-3 py-2 font-mono text-[11px] font-normal text-ink-muted">
                  {rowNumber}
                </th>
                {columns.map((column) => {
                  const error = marked.get(`${rowNumber}:${column.key}`);
                  return (
                    <td
                      key={column.key}
                      data-invalid={error ? "true" : undefined}
                      aria-invalid={error ? "true" : undefined}
                      title={error?.message}
                      className={cn(
                        "max-w-56 px-3 py-2 font-sans text-sm break-words text-ink",
                        error && "bg-paper-sunk shadow-[inset_0_0_0_2px_var(--vermilion-deep)]",
                      )}
                    >
                      {row[column.key] ?? ""}
                      {error && <span className="sr-only"> (error: {error.message})</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
