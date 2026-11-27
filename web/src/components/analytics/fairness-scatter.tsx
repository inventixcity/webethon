"use client";

import { useId } from "react";
import type { FairnessReport } from "@/lib/exam/types";
import { cn } from "@/lib/utils";

type FairnessRow = FairnessReport["rows"][number];

const W = 640;
const H = 380;
const LEFT = 60;
const RIGHT = 24;
const TOP = 20;
const BOTTOM = 60;
const TICKS = [0, 25, 50, 75, 100];

const px = (value: number) => LEFT + (value / 100) * (W - LEFT - RIGHT);
const py = (value: number) => TOP + (1 - value / 100) * (H - TOP - BOTTOM);

/**
 * Predicted facility against observed percent, one dot per candidate. The dashed diagonal is where a dot would sit if
 * the paper's predicted difficulty matched the score. Candidate labels are the blind labels as the server gives them.
 * The chart has a text summary and a visually hidden table of the same numbers.
 */
export function FairnessScatter({ rows, className }: { rows: FairnessRow[]; className?: string }) {
  const titleId = useId();
  const descId = useId();
  const plotted = rows.flatMap((row) =>
    row.observedPercent === null
      ? []
      : [{ ...row, x: clamp(row.predictedFacility * 100), y: clamp(row.observedPercent) }],
  );
  const unplotted = rows.length - plotted.length;

  const summary =
    plotted.length === 0
      ? `No graded scores yet. ${rows.length} ${rows.length === 1 ? "paper is" : "papers are"} waiting for marks.`
      : `${plotted.length} ${plotted.length === 1 ? "candidate is" : "candidates are"} plotted, with predicted facility from ${Math.min(...plotted.map((p) => p.x)).toFixed(0)}% to ${Math.max(...plotted.map((p) => p.x)).toFixed(0)}% and observed scores from ${Math.min(...plotted.map((p) => p.y)).toFixed(0)}% to ${Math.max(...plotted.map((p) => p.y)).toFixed(0)}%.${unplotted > 0 ? ` ${unplotted} without a graded score ${unplotted === 1 ? "is" : "are"} not plotted.` : ""}`;

  return (
    <figure className={cn("grid gap-3", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="h-auto w-full overflow-visible"
      >
        <title id={titleId}>Predicted facility against observed percent, per candidate</title>
        <desc id={descId}>{summary}</desc>

        {TICKS.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={W - RIGHT} y1={py(tick)} y2={py(tick)} className="stroke-ink/15" strokeWidth={1} />
            <line x1={px(tick)} x2={px(tick)} y1={TOP} y2={H - BOTTOM} className="stroke-ink/15" strokeWidth={1} />
            <text x={LEFT - 10} y={py(tick) + 4} textAnchor="end" className="fill-ink-muted font-mono text-[12px] tabular-nums">
              {tick}
            </text>
            <text x={px(tick)} y={H - BOTTOM + 22} textAnchor="middle" className="fill-ink-muted font-mono text-[12px] tabular-nums">
              {tick}
            </text>
          </g>
        ))}

        <line x1={LEFT} x2={W - RIGHT} y1={H - BOTTOM} y2={H - BOTTOM} className="stroke-ink" strokeWidth={1} />
        <line x1={LEFT} x2={LEFT} y1={TOP} y2={H - BOTTOM} className="stroke-ink" strokeWidth={1} />
        <line
          x1={px(0)}
          y1={py(0)}
          x2={px(100)}
          y2={py(100)}
          className="stroke-ink-muted"
          strokeWidth={1}
          strokeDasharray="4 4"
        />

        {plotted.map((point) => (
          <circle key={point.attemptId} cx={px(point.x)} cy={py(point.y)} r={5} className="fill-cobalt stroke-paper" strokeWidth={1.5}>
            <title>{`${point.candidate}: predicted ${point.x.toFixed(1)}%, observed ${point.y.toFixed(1)}%`}</title>
          </circle>
        ))}

        <text x={(LEFT + W - RIGHT) / 2} y={H - 14} textAnchor="middle" className="fill-ink-soft font-mono text-[12px]">
          Predicted facility (%)
        </text>
        <text
          x={16}
          y={(TOP + H - BOTTOM) / 2}
          textAnchor="middle"
          transform={`rotate(-90 16 ${(TOP + H - BOTTOM) / 2})`}
          className="fill-ink-soft font-mono text-[12px]"
        >
          Observed (%)
        </text>
      </svg>

      <figcaption className="text-sm text-ink-soft">{summary}</figcaption>

      <table className="sr-only">
        <caption>Predicted facility and observed percent for each candidate</caption>
        <thead>
          <tr>
            <th scope="col">Candidate</th>
            <th scope="col">Predicted facility</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.attemptId}>
              <th scope="row">{row.candidate}</th>
              <td>{(row.predictedFacility * 100).toFixed(1)}%</td>
              <td>{row.observedPercent === null ? "Not graded" : `${row.observedPercent.toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
