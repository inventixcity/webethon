"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ExamAnalytics } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

type Bucket = ExamAnalytics["histogram"][number];

/** The bucket the mean falls in. The top bucket also takes a mean of exactly 100. */
export function meanBucket(buckets: readonly Bucket[], mean: number): number {
  const index = buckets.findIndex((bucket) => mean >= bucket.from && mean < bucket.to);
  if (index !== -1) return index;
  return mean >= 100 && buckets.length > 0 ? buckets.length - 1 : -1;
}

/**
 * The score distribution as square columns that grow from the baseline. The band holding the mean is the one
 * vermilion mark on the view, and a hairline marks the exact mean.
 */
export function ScoreHistogram({ buckets, mean }: { buckets: readonly Bucket[]; mean: number }) {
  const reduced = useReducedMotion() ?? false;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const band = meanBucket(buckets, mean);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const clampedMean = Math.min(100, Math.max(0, mean));

  return (
    <figure className="grid gap-4">
      <div className="relative">
        <div
          role="img"
          aria-label={`Histogram of ${total} candidates by percentage. Mean ${formatPercent(mean, 1)}.`}
          className="relative grid h-64 grid-cols-10 items-end border-b border-ink"
        >
          {buckets.map((bucket, index) => {
            const ratio = bucket.count / max;
            const current = index === band;
            return (
              <div key={bucket.from} className="relative flex h-full min-w-0 flex-col justify-end px-px">
                <span className="mb-1 text-center font-mono text-[10px] text-ink-soft tabular-nums">{bucket.count}</span>
                <motion.div
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: ratio }}
                  transition={{ duration: 0.6, delay: reduced ? 0 : index * 0.05, ease: [0.22, 1, 0.36, 1] }}
                  style={{ height: "100%", transformOrigin: "bottom" }}
                  className={cn("w-full", current ? "bg-amber" : bucket.count === 0 ? "bg-rule" : "bg-cobalt")}
                />
              </div>
            );
          })}
          {band !== -1 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-vermilion-deep"
              style={{ left: `${clampedMean}%` }}
            >
              <span className="absolute -top-1 left-2 whitespace-nowrap bg-paper px-1 font-mono text-[10px] tracking-[0.08em] text-vermilion-deep uppercase">
                Mean {formatPercent(mean, 1)}
              </span>
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-10 font-mono text-[10px] text-ink-muted tabular-nums">
          {buckets.map((bucket) => (
            <span key={bucket.from} className="pt-2 text-center">
              {bucket.from}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="font-mono text-[11px] tracking-[0.06em] text-ink-muted uppercase">
        Candidates by percentage band
      </figcaption>
      <table className="sr-only">
        <caption>Candidates by percentage band</caption>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.from}>
              <th scope="row">
                {bucket.from} to {bucket.to} percent
              </th>
              <td>{bucket.count} candidates</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
