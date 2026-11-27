"use client";

import { useEffect, useId } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ui/meter";
import type { BlueprintPreview } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { isNotFound, percentLabel, scoreTone, toleranceLabel } from "./blueprint-model";
import { useResource } from "./use-resource";
import { LoadingState } from "./states";

type BlueprintPreviewProps = {
  examId: string;
  /** Changes after a save, so the preview draws the blueprint that was just stored. */
  refreshKey: number;
  /** The tolerance that was saved. The chart shades this band around the mean. */
  tolerance: number;
  className?: string;
};

/**
 * The preview of the saved blueprint: whether it can be drawn, the pool and paper sizes, the fairness score and a
 * strip chart of 50 simulated papers. Hidden when the endpoint is not there (404).
 */
export function BlueprintPreviewPanel({ examId, refreshKey, tolerance, className }: BlueprintPreviewProps) {
  const toast = useToast();
  const headingId = useId();
  const resource = useResource<BlueprintPreview>(`/exams/${encodeURIComponent(examId)}/blueprint/preview`, refreshKey);
  const { data, error, loading, reload } = resource;

  useEffect(() => {
    if (error && !isNotFound(error)) {
      toast.error("Could not load the blueprint preview.", { action: { label: "Try again", onClick: reload } });
    }
  }, [error, reload, toast]);

  if (isNotFound(error)) return null;

  return (
    <section aria-labelledby={headingId} className={cn("grid gap-6", className)}>
      <h3 id={headingId} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        <span className="text-cobalt-deep tabular-nums">Preview</span> / Simulated papers
      </h3>

      {loading && !data ? <LoadingState label="Simulating papers" rows={2} /> : null}

      {!loading && !data && error ? (
        <div className="grid max-w-prose justify-items-start gap-3 border-l-2 border-vermilion-deep pl-5">
          <p className="text-sm text-ink-soft">The preview could not be drawn. Try again, or save the blueprint first.</p>
          <Button variant="secondary" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}

      {data ? <PreviewBody preview={data} tolerance={tolerance} /> : null}
    </section>
  );
}

function PreviewBody({ preview, tolerance }: { preview: BlueprintPreview; tolerance: number }) {
  const tone = scoreTone(preview.fairnessScore);
  const scoreClass = tone === "fair" ? "text-cobalt" : "text-amber-deep";
  const spreadPoints = (preview.spread * 100).toFixed(1);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)]">
      <div className="grid content-start gap-6">
        <div className="grid gap-2">
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Fairness score</p>
          <p className={cn("text-[84px] leading-none font-medium tracking-[-0.03em] tabular-nums", scoreClass)}>
            {preview.fairnessScore}
            <span className="ml-2 font-mono text-base tracking-normal text-ink-muted">/ 100</span>
          </p>
          <Meter
            value={preview.fairnessScore}
            max={100}
            tone={tone === "fair" ? "info" : "caution"}
            label="Fairness score"
            valueText={`${preview.fairnessScore} out of 100`}
            size="md"
          />
          <p className="text-sm text-ink-soft">
            Spread of {spreadPoints} points between simulated papers, against a tolerance of {toleranceLabel(tolerance)}.
          </p>
        </div>

        <p
          className={cn(
            "border-l-2 py-1 pl-4 font-mono text-[11px] tracking-[0.12em] uppercase",
            preview.feasible ? "border-cobalt text-ink" : "border-vermilion-deep text-ink",
          )}
        >
          {preview.feasible ? "Feasible" : "Not feasible"}
        </p>

        <dl className="grid grid-cols-3 border-t border-rule">
          <Figure label="Pool" value={preview.poolSize} />
          <Figure label="Paper" value={preview.paperSize} />
          <Figure label="Marks" value={preview.totalMarks} />
        </dl>

        {preview.problems.length > 0 ? (
          <div className="grid gap-2">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Problems</p>
            <ul className="grid list-disc gap-1 pl-5 text-sm text-ink">
              {preview.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <PaperStrip values={preview.simulated} tolerance={tolerance} />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-1 border-r border-rule px-3 py-3 last:border-r-0">
      <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
      <dd className="text-2xl font-medium tabular-nums">{value}</dd>
    </div>
  );
}

const CHART_W = 640;
const CHART_H = 148;
const PAD_X = 28;
const BAND_TOP = 16;
const BAND_BOTTOM = 96;
const AXIS_Y = 112;
const LANES = 5;

/**
 * Predicted facility for each simulated paper, as dots on a hairline axis. The tolerance band is shaded around the
 * mean. Dots are spread over a few lanes so they don't pile up. The chart has a text summary and a hidden table.
 */
export function PaperStrip({ values, tolerance, className }: { values: number[]; tolerance: number; className?: string }) {
  const titleId = useId();
  const descId = useId();

  if (values.length === 0) {
    return <p className={cn("text-sm text-ink-muted", className)}>No simulated papers yet. Save the blueprint to draw them.</p>;
  }

  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const bandLow = mean - tolerance;
  const bandHigh = mean + tolerance;

  // The domain covers every dot and the band, with a margin, and is never narrower than 20 points so the dots stay apart.
  let lo = Math.min(low, bandLow) - 0.03;
  let hi = Math.max(high, bandHigh) + 0.03;
  if (hi - lo < 0.2) {
    const mid = (lo + hi) / 2;
    lo = mid - 0.1;
    hi = mid + 0.1;
  }
  lo = Math.max(0, lo);
  hi = Math.min(1, hi);

  const x = (value: number) => PAD_X + ((value - lo) / (hi - lo)) * (CHART_W - PAD_X * 2);
  const ticks = [lo, mean, hi];
  const summary = `Predicted facility across ${values.length} simulated papers runs from ${percentLabel(low)} to ${percentLabel(high)}, with a mean of ${percentLabel(mean)}. The shaded band is the tolerance, ${toleranceLabel(tolerance)}.`;

  return (
    <figure className={cn("grid gap-3", className)}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="h-auto w-full overflow-visible"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>Predicted facility of 50 simulated papers</title>
        <desc id={descId}>{summary}</desc>

        <rect
          x={x(bandLow)}
          y={BAND_TOP - 6}
          width={Math.max(0, x(bandHigh) - x(bandLow))}
          height={BAND_BOTTOM - BAND_TOP + 12}
          className="fill-cobalt/15"
        />
        <line x1={x(mean)} x2={x(mean)} y1={BAND_TOP - 6} y2={BAND_BOTTOM + 6} className="stroke-cobalt" strokeWidth={1} />

        {values.map((value, index) => (
          <circle
            key={index}
            cx={x(value)}
            cy={BAND_TOP + 8 + (index % LANES) * ((BAND_BOTTOM - BAND_TOP - 16) / (LANES - 1))}
            r={4}
            className="fill-cobalt"
          />
        ))}

        <line x1={PAD_X} x2={CHART_W - PAD_X} y1={AXIS_Y} y2={AXIS_Y} className="stroke-ink" strokeWidth={1} />
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={x(tick)} x2={x(tick)} y1={AXIS_Y} y2={AXIS_Y + 6} className="stroke-ink" strokeWidth={1} />
            <text
              x={x(tick)}
              y={AXIS_Y + 22}
              textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
              className="fill-ink-muted font-mono text-[12px] tabular-nums"
            >
              {percentLabel(tick)}
            </text>
          </g>
        ))}
        <text x={PAD_X} y={BAND_TOP - 8} className="fill-ink-muted font-mono text-[12px]">
          Predicted facility (higher is easier)
        </text>
      </svg>

      <figcaption className="text-sm text-ink-soft">
        {summary}
      </figcaption>

      <table className="sr-only">
        <caption>Predicted facility for each simulated paper</caption>
        <thead>
          <tr>
            <th scope="col">Paper</th>
            <th scope="col">Predicted facility</th>
          </tr>
        </thead>
        <tbody>
          {values.map((value, index) => (
            <tr key={index}>
              <th scope="row">Paper {index + 1}</th>
              <td>{percentLabel(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
