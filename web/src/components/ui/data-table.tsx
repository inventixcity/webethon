import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Numbers align right, so the digits line up. */
  align?: "left" | "right";
  /**
   * The row's name (a th with scope="row"). On phones it spans the full width of the stacked row. Mark exactly one
   * column as primary.
   */
  primary?: boolean;
  /** Label shown beside the value in the stacked phone layout. Defaults to `header` when it is a string. */
  mobileLabel?: string;
  /** Leave the cell out of the stacked phone layout (for redundant detail). */
  hideOnMobile?: boolean;
  /** On phones, give the cell the full row width instead of half. */
  wide?: boolean;
  className?: string;
  headerClassName?: string;
};

type DataTableProps<T> = {
  /** Every table has a caption. It is visually hidden unless `showCaption` is set. */
  caption: string;
  showCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** A stable id for rows that need extra emphasis (selected, flagged). */
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Keeps the header in view while the body scrolls inside the table frame (md and up). */
  stickyHeader?: boolean;
  /** Max height of the frame when the header is sticky. */
  maxHeight?: string;
  className?: string;
};

/**
 * A table that stays a table where there is room and becomes a stack of labelled rows on phones, so nothing
 * scrolls sideways at 360px. The DOM is one table in both layouts: screen readers always get rows and headers.
 */
export function DataTable<T>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  rowClassName,
  stickyHeader = true,
  maxHeight = "min(72vh, 52rem)",
  className,
}: DataTableProps<T>) {
  return (
    <div
      data-slot="data-table"
      className={cn("border-y border-ink md:overflow-auto md:border md:border-rule", stickyHeader && "md:max-h-(--table-max)", className)}
      style={stickyHeader ? ({ "--table-max": maxHeight } as React.CSSProperties) : undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-left text-sm max-md:block">
        <caption
          className={cn(
            showCaption
              ? "px-3 py-3 text-left font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase max-md:block max-md:px-0"
              : "sr-only",
          )}
        >
          {caption}
        </caption>
        <thead className="max-md:sr-only">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "border-b border-ink bg-paper-sunk px-3 py-3 font-mono text-[11px] font-medium tracking-[0.12em] whitespace-nowrap text-ink-soft uppercase",
                  stickyHeader && "md:sticky md:top-0 md:z-[1]",
                  column.align === "right" && "text-right",
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-md:block">
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className={cn(
                "align-top transition-colors duration-(--duration-fast) md:hover:bg-paper-raised",
                "max-md:border-t max-md:border-rule max-md:first:border-t-0",
                "max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-3 max-md:py-5",
                rowClassName?.(row, index),
              )}
            >
              {columns.map((column) => {
                const label = column.mobileLabel ?? (typeof column.header === "string" ? column.header : "");
                const Cell = column.primary ? "th" : "td";
                return (
                  <Cell
                    key={column.key}
                    scope={column.primary ? "row" : undefined}
                    data-label={column.primary ? undefined : label}
                    className={cn(
                      "px-3 py-3 font-normal md:border-b md:border-rule md:[tr:last-child>&]:border-b-0",
                      column.align === "right" && "text-right tabular-nums",
                      "max-md:grid max-md:content-start max-md:gap-1 max-md:p-0 max-md:text-left",
                      !column.primary &&
                        "max-md:before:font-mono max-md:before:text-[10px] max-md:before:tracking-[0.12em] max-md:before:text-ink-muted max-md:before:uppercase max-md:before:content-[attr(data-label)]",
                      (column.primary || column.wide) && "max-md:col-span-2",
                      column.hideOnMobile && "max-md:hidden",
                      column.className,
                    )}
                  >
                    {column.cell(row, index)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
