"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type FlipColumn<Row> = {
  key: keyof Row & string;
  label: string;
  /** Right-aligned, in tabular figures. */
  numeric?: boolean;
  /** Hidden on phones. */
  optional?: boolean;
  format?: (value: Row[keyof Row]) => string;
};

export type FlipTableProps<Row extends { id: string }> = {
  rows: readonly Row[];
  columns: readonly FlipColumn<Row>[];
  label: string;
  /** Placeholder text for the search box. */
  filterLabel?: string;
  /** Which column it opens sorted by. */
  initialSort: keyof Row & string;
  className?: string;
};

const SPRING = { type: "spring", stiffness: 420, damping: 36, mass: 0.8 } as const;

/** A table where nothing teleports. Rows glide to their new place on every sort, filter, or live update. */
export function FlipTable<Row extends { id: string }>({
  rows,
  columns,
  label,
  filterLabel = "Filter",
  initialSort,
  className,
}: FlipTableProps<Row>) {
  const [sort, setSort] = useState<{ key: keyof Row & string; ascending: boolean }>({ key: initialSort, ascending: false });
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? rows.filter((row) => columns.some((column) => String(row[column.key]).toLowerCase().includes(needle)))
      : rows;
    return [...matches].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const order =
        typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return (sort.ascending ? order : -order) || a.id.localeCompare(b.id);
    });
  }, [rows, columns, query, sort]);

  const template = {
    "--row": `2.5rem ${columns.map((column) => (column.numeric ? "5.5rem" : column.optional ? "1fr" : "1.6fr")).join(" ")}`,
    "--row-phone": `2rem ${columns
      .filter((column) => !column.optional)
      .map((column) => (column.numeric ? "4.5rem" : "1fr"))
      .join(" ")}`,
  } as React.CSSProperties;
  const grid = "grid items-center grid-cols-(--row-phone) gap-x-3 px-3 sm:grid-cols-(--row)";

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn("w-full max-w-4xl", className)} style={template}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={filterLabel}
          aria-label={filterLabel}
          className="mb-4 h-11 w-full max-w-xs border border-ink bg-paper-raised px-3 text-sm outline-none placeholder:text-ink/40 focus:outline-2 focus:outline-vermilion"
        />
        <div role="table" aria-label={label} className="relative border-t border-ink">
          <div role="row" className={cn(grid, "h-11 border-b border-ink")}>
            <span role="columnheader" className="font-mono text-[11px] tracking-[0.1em] text-ink-muted">
              #
            </span>
            {columns.map((column) => {
              const active = sort.key === column.key;
              return (
                <span
                  key={column.key}
                  role="columnheader"
                  aria-sort={active ? (sort.ascending ? "ascending" : "descending") : "none"}
                  className={cn(column.numeric && "text-right", column.optional && "max-sm:hidden")}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) => ({
                        key: column.key,
                        ascending: current.key === column.key ? !current.ascending : Boolean(!column.numeric),
                      }))
                    }
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] tracking-[0.1em] uppercase",
                      active ? "text-ink" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {column.label}
                    {active && (sort.ascending ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                  </button>
                </span>
              );
            })}
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((row, index) => (
              <motion.div
                key={row.id}
                role="row"
                layout="position"
                transition={SPRING}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={cn(grid, "h-12 w-full border-b border-rule bg-paper hover:bg-paper-sunk")}
              >
                <span role="cell" className="font-mono text-xs text-ink-muted tabular-nums">
                  {index + 1}
                </span>
                {columns.map((column) => {
                  const value = row[column.key];
                  const text = column.format ? column.format(value) : String(value);
                  return (
                    <span
                      key={column.key}
                      role="cell"
                      className={cn(
                        "truncate text-sm",
                        column.numeric && "text-right font-mono tabular-nums",
                        column.optional && "text-ink-soft max-sm:hidden",
                      )}
                    >
                      {column.numeric ? (
                        // Remounting on change is what makes a new value flash.
                        <motion.span
                          key={String(value)}
                          initial={{ backgroundColor: "var(--vermilion)", color: "#fff" }}
                          animate={{ backgroundColor: "rgba(0,0,0,0)", color: "var(--ink)" }}
                          transition={{ duration: 0.7 }}
                          className="px-1"
                        >
                          {text}
                        </motion.span>
                      ) : (
                        text
                      )}
                    </span>
                  );
                })}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        {visible.length === 0 && <p className="py-6 text-sm text-ink-muted">Nothing matches that filter.</p>}
      </div>
    </MotionConfig>
  );
}
