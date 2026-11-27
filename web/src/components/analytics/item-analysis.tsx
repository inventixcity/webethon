"use client";

import { Fragment, useId, useState } from "react";
import type { ItemAnalytics } from "@/lib/exam/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

const FLAG_INFO: Record<ItemAnalytics["flags"][number], { label: string; help: string }> = {
  too_easy: { label: "Too easy", help: "Over 90% of the marks were earned. It may not separate strong and weak candidates." },
  too_hard: { label: "Too hard", help: "Under 20% of the marks were earned. Check the wording and the answer key." },
  negative_discrimination: {
    label: "Negative discrimination",
    help: "Stronger candidates did worse on this item than weaker ones. Check the answer key first.",
  },
  often_skipped: { label: "Often skipped", help: "More than a quarter of candidates left this item blank." },
  dead_distractor: { label: "Dead option", help: "A wrong option was never chosen. It may not be doing its job." },
};

/** Flags are review prompts: too easy is informational cobalt, every other flag needs a look and takes amber. */
const FLAG_TONE: Record<ItemAnalytics["flags"][number], string> = {
  too_easy: "border-cobalt text-cobalt-deep",
  too_hard: "border-amber bg-amber text-ink",
  negative_discrimination: "border-amber bg-amber text-ink",
  often_skipped: "border-amber bg-amber text-ink",
  dead_distractor: "border-amber bg-amber text-ink",
};

const TEXT_LIMIT = 90;
const preview = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);

function discriminationText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** Per-item table with flags and an expandable distractor analysis. */
export function ItemAnalysis({ items }: { items: ItemAnalytics[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const idBase = useId();

  if (items.length === 0) {
    return <p className="border border-rule p-4 text-sm text-ink-muted">No items were analysed.</p>;
  }

  return (
    <div className="overflow-x-auto border border-rule">
      <table className="w-full min-w-[820px] text-left text-sm">
        <caption className="sr-only">Item analysis: facility, discrimination, skipped rate and flags for each question</caption>
        <thead className="bg-paper-sunk">
          <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
            <th scope="col" className="px-3 py-3 font-medium">No.</th>
            <th scope="col" className="px-3 py-3 font-medium">Question</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Facility</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Discrimination</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Skipped</th>
            <th scope="col" className="px-3 py-3 font-medium">Flags</th>
            <th scope="col" className="px-3 py-3 font-medium">
              <span className="sr-only">Options</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const expanded = openId === item.itemId;
            const panelId = `${idBase}-${item.itemId}`;
            return (
              <Fragment key={item.itemId}>
                <tr className="border-t border-rule align-top">
                  <th scope="row" className="px-3 py-3 font-mono font-normal">{item.position}</th>
                  <td className="px-3 py-3">
                    <span className="block font-sans">{preview(item.stem)}</span>
                    <span className="font-mono text-[11px] text-ink-muted">
                      {item.topic} · {item.attempts} {item.attempts === 1 ? "attempt" : "attempts"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {item.facility === null ? "—" : formatPercent(item.facility * 100)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{discriminationText(item.discrimination)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{formatPercent(item.skipRate * 100)}</td>
                  <td className="px-3 py-3">
                    {item.flags.length === 0 ? (
                      <span className="font-mono text-[11px] text-ink-muted">None</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1.5">
                        {item.flags.map((flag) => (
                          <li key={flag}>
                            <span
                              tabIndex={0}
                              title={FLAG_INFO[flag].help}
                              className={cn("inline-block cursor-help border px-2 py-0.5 font-mono text-[11px] tracking-[0.06em] uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion", FLAG_TONE[flag])}
                            >
                              {FLAG_INFO[flag].label}
                              <span className="sr-only">: {FLAG_INFO[flag].help}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      variant="link"
                      size="sm"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setOpenId(expanded ? null : item.itemId)}
                    >
                      {expanded ? "Hide options" : "Options"}
                      <span className="sr-only"> for question {item.position}</span>
                    </Button>
                  </td>
                </tr>
                {expanded && (
                  <tr id={panelId} className="border-t border-rule bg-paper-raised">
                    <td colSpan={7} className="px-3 py-4">
                      <DistractorList item={item} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DistractorList({ item }: { item: ItemAnalytics }) {
  if (item.options.length === 0) {
    return <p className="text-sm text-ink-muted">This item has no option breakdown (written answers are graded by hand).</p>;
  }
  return (
    <div className="grid gap-4">
      <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        Option choices · {item.attempts} {item.attempts === 1 ? "attempt" : "attempts"}
      </p>
      <ul className="grid gap-3">
        {item.options.map((option) => {
          const share = item.attempts > 0 ? Math.min(100, (option.picks / item.attempts) * 100) : 0;
          return (
            <li key={option.id} className="grid gap-1.5">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className={option.correct ? "font-medium" : ""}>
                  {option.text}
                  {option.correct && (
                    <span className="ml-2 border border-ink px-1.5 font-mono text-[10px] tracking-[0.12em] uppercase">
                      Correct answer
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs tabular-nums">
                  {option.picks} picks · {formatPercent(share)}
                </span>
              </div>
              <div aria-hidden="true" className="h-2 bg-paper-sunk">
                <div className={option.correct ? "h-full bg-ink" : "h-full bg-ink/40"} style={{ width: `${share}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
