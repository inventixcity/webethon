"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ExamAnalytics } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

type Bucket = ExamAnalytics["histogram"][number];

/** The band holding the mean; exactly 100 belongs to the final band. */
export function meanBucket(buckets: readonly Bucket[], mean: number): number {
  const index = buckets.findIndex((bucket) => mean >= bucket.from && mean < bucket.to);
  if (index !== -1) return index;
  return mean >= 100 && buckets.length > 0 ? buckets.length - 1 : -1;
}

/** Score distribution scaled to the largest band, with a dedicated title, axis and empty state. */
export function ScoreHistogram({ buckets, mean }: { buckets: readonly Bucket[]; mean: number }) {
  const reduced = useReducedMotion() ?? false;
  const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
  const band = meanBucket(buckets, mean);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const clampedMean = Math.min(100, Math.max(0, mean));

  return (
    <figure aria-labelledby="score-distribution-title" className="grid gap-4">
      <figcaption id="score-distribution-title" className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
        Candidates by percentage band
      </figcaption>
      {total === 0 ? (
        <div className="grid min-h-52 place-items-center border border-rule p-6 text-center">
          <p className="max-w-xs text-sm text-ink-muted">No candidate scores are available in this distribution yet.</p>
        </div>
      ) : (
        <>
          <div
            role="img"
            aria-label={`Histogram of ${total} candidates by percentage. Mean ${formatPercent(mean, 1)}.`}
            className="relative grid h-56 grid-cols-10 items-end border-b border-ink pt-8"
          >
            {buckets.map((bucket, index) => {
              const ratio = max > 0 ? bucket.count / max : 0;
              const height = bucket.count > 0 ? Math.max(4, ratio * 100) : 0;
              const current = index === band;
              return (
                <div key={bucket.from} className="relative flex h-full min-w-0 items-end justify-center px-1">
                  {bucket.count > 0 && (
                    <span className="absolute z-10 whitespace-nowrap font-mono text-[10px] leading-none text-ink tabular-nums" style={{ bottom: `calc(${height}% + 6px)` }}>
                      {bucket.count}
                    </span>
                  )}
                  <motion.div
                    initial={reduced ? false : { scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: 0.6, delay: reduced ? 0 : index * 0.05, ease: [0.22, 1, 0.36, 1] }}
                    style={{ height: `${height}%`, minHeight: bucket.count > 0 ? 4 : 0, transformOrigin: "bottom" }}
                    className={cn("w-full", current ? "bg-amber" : bucket.count === 0 ? "bg-transparent" : "bg-cobalt")}
                  />
                </div>
              );
            })}
            {band !== -1 ? (
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-vermilion-deep" style={{ left: `${clampedMean}%` }}>
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-10 font-mono text-[10px] text-ink-muted tabular-nums" aria-label="Score percentage axis">
            {buckets.map((bucket) => (
              <span key={bucket.from} className="pt-2 text-center">{bucket.from}</span>
            ))}
          </div>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] tracking-[0.06em] text-ink-muted uppercase">
            <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-3 w-px bg-vermilion-deep" />Mean {formatPercent(mean, 1)}</span>
            <span>Score percentage · bands from 0 to 100</span>
          </p>
        </>
      )}
      <table className="sr-only">
        <caption>Candidates by percentage band</caption>
        <tbody>{buckets.map((bucket) => <tr key={bucket.from}><th scope="row">{bucket.from} to {bucket.to} percent</th><td>{bucket.count} candidates</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
