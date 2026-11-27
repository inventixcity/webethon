"use client";

import { Trash2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DIFFICULTY_LEVELS,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
  TOLERANCE_STEP,
  emptyRow,
  toleranceLabel,
  type DraftRow,
} from "./blueprint-model";

type BlueprintRowsProps = {
  rows: DraftRow[];
  topics: readonly string[];
  rowIssues: Record<string, string>;
  tolerance: number;
  examTotal: number;
  blueprintTotal: number;
  totalDifference: number;
  onRowsChange: (rows: DraftRow[]) => void;
  onToleranceChange: (value: number) => void;
  className?: string;
};

/**
 * The editable part of the blueprint: one row per topic and difficulty band, the tolerance, and the running marks
 * total against the exam total. Controlled by the parent, which owns validation and the save.
 */
export function BlueprintRows({
  rows,
  topics,
  rowIssues,
  tolerance,
  examTotal,
  blueprintTotal,
  totalDifference,
  onRowsChange,
  onToleranceChange,
  className,
}: BlueprintRowsProps) {
  const baseId = useId();
  const sliderId = `${baseId}-tolerance`;
  const sliderHelpId = `${baseId}-tolerance-help`;
  const noTopics = topics.length === 0;
  const mismatch = totalDifference !== 0;

  function update(key: string, patch: Partial<DraftRow>) {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function remove(key: string) {
    onRowsChange(rows.filter((row) => row.key !== key));
  }

  function add() {
    onRowsChange([...rows, emptyRow(topics[0] ?? "")]);
  }

  return (
    <div className={cn("grid gap-6", className)}>
      {rows.length === 0 ? (
        <p className="border-l-2 border-rule py-1 pl-4 text-sm text-ink-soft">
          No rows yet. Each row draws a set number of questions on one topic from a difficulty band.
        </p>
      ) : (
        <div className="overflow-x-auto border border-rule">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="sr-only">Blueprint rows: topic, difficulty band, count and marks each</caption>
            <thead className="bg-paper-sunk">
              <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                <th scope="col" className="px-3 py-3 font-medium">Topic</th>
                <th scope="col" className="px-3 py-3 font-medium">Difficulty from</th>
                <th scope="col" className="px-3 py-3 font-medium">To</th>
                <th scope="col" className="px-3 py-3 font-medium">Count</th>
                <th scope="col" className="px-3 py-3 font-medium">Marks each</th>
                <th scope="col" className="px-3 py-3">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const n = index + 1;
                const issue = rowIssues[row.key];
                const issueId = `${baseId}-issue-${row.key}`;
                return (
                  <tr key={row.key} className="border-t border-rule align-top">
                    <td className="px-3 py-3">
                      <Select
                        size="sm"
                        aria-label={`Topic, row ${n}`}
                        aria-invalid={issue ? true : undefined}
                        aria-describedby={issue ? issueId : undefined}
                        value={row.topic}
                        onChange={(event) => update(row.key, { topic: event.target.value })}
                      >
                        {row.topic === "" || topics.includes(row.topic) ? null : (
                          <option value={row.topic}>{row.topic} (not on paper)</option>
                        )}
                        {topics.map((topic) => (
                          <option key={topic} value={topic}>
                            {topic}
                          </option>
                        ))}
                      </Select>
                      {issue ? (
                        <p id={issueId} className="mt-2 text-xs text-vermilion-deep">
                          Row {n}: {issue}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        size="sm"
                        aria-label={`Lowest difficulty, row ${n}`}
                        value={row.minDifficulty}
                        onChange={(event) => update(row.key, { minDifficulty: Number(event.target.value) })}
                      >
                        {DIFFICULTY_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        size="sm"
                        aria-label={`Highest difficulty, row ${n}`}
                        value={row.maxDifficulty}
                        onChange={(event) => update(row.key, { maxDifficulty: Number(event.target.value) })}
                      >
                        {DIFFICULTY_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        variant="box"
                        inputSize="sm"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        aria-label={`Count, row ${n}`}
                        value={row.count}
                        onChange={(event) => update(row.key, { count: event.target.value })}
                        className="tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        variant="box"
                        inputSize="sm"
                        type="number"
                        inputMode="decimal"
                        min={0.25}
                        step={0.25}
                        aria-label={`Marks each, row ${n}`}
                        value={row.marksEach}
                        onChange={(event) => update(row.key, { marksEach: event.target.value })}
                        className="tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove(row.key)} aria-label={`Remove row ${n}`} className="px-2">
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <Button variant="secondary" size="sm" onClick={add} disabled={noTopics}>
          Add row
        </Button>
        {noTopics ? <p className="text-sm text-ink-muted">Add questions to the paper first. Topics come from the paper.</p> : null}
      </div>

      <div className="grid gap-6 border-t border-ink pt-6 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <Label htmlFor={sliderId}>Tolerance</Label>
            <output htmlFor={sliderId} className="font-mono text-sm tabular-nums" aria-live="polite">
              {toleranceLabel(tolerance)}
            </output>
          </div>
          <input
            id={sliderId}
            type="range"
            min={TOLERANCE_MIN}
            max={TOLERANCE_MAX}
            step={TOLERANCE_STEP}
            value={tolerance}
            aria-valuetext={toleranceLabel(tolerance)}
            aria-describedby={sliderHelpId}
            onChange={(event) => onToleranceChange(Number(event.target.value))}
            className="h-6 w-full cursor-pointer accent-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <p id={sliderHelpId} className="text-sm text-ink-soft">
            How far apart two candidates' papers may be in predicted difficulty. Smaller is stricter, and may leave too few
            questions to draw from.
          </p>
        </div>

        <div className="grid content-start gap-3">
          <p role="status" className="font-mono text-[11px] tracking-[0.12em] uppercase">
            <span className="text-ink-muted">Blueprint total </span>
            <span className="tabular-nums">{blueprintTotal}</span>
            <span className="text-ink-muted"> of {examTotal} exam marks</span>
          </p>
          {mismatch ? (
            <p className="border-l-2 border-amber pl-4 text-sm text-ink">
              {totalDifference > 0
                ? `The rows add up to ${blueprintTotal}, but the exam needs ${examTotal}. Remove ${totalDifference} marks.`
                : `The rows add up to ${blueprintTotal}, but the exam needs ${examTotal}. Add ${-totalDifference} marks.`}{" "}
              The exam can't be published until they match.
            </p>
          ) : rows.length > 0 ? (
            <p className="text-sm text-ink-soft">The rows match the exam total.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
