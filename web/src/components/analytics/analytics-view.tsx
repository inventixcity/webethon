"use client";

import { useEffect, useId, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamAnalytics } from "@/lib/exam/types";
import { BarChart } from "@/components/charts";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { Stat, StatGrid } from "@/components/ui/stat";
import { formatMarks, formatPercent, messageOf } from "./format";
import { ItemAnalysis } from "./item-analysis";

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/**
 * The pass rate is a fraction (0 to 1) from the server. A value above 1 is read as a percentage, so the screen
 * stays correct if the server sends either form.
 */
export function passPercent(passRate: number): number {
  return passRate <= 1 ? passRate * 100 : passRate;
}

/** Plain-language note for the reliability estimate. */
function reliabilityNote(value: number | null): string {
  if (value === null) {
    return "Not enough varied results yet to estimate reliability. It needs at least three submissions with different scores.";
  }
  return "Reliability (0 to 1) shows how consistently the questions rank candidates. Values of 0.7 or higher are usually considered good for a classroom test.";
}

/** Exam analytics: score summary, distribution, topics, item analysis and the similar-answer indicator. */
export function AnalyticsView({ examId }: { examId: string }) {
  const [data, setData] = useState<ExamAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const headingId = useId();

  useEffect(() => {
    let live = true;
    setError(null);
    api<ExamAnalytics>(`/exams/${examId}/analytics`)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [examId, version]);

  if (error) {
    return (
      <div className="m-4 grid gap-3 border border-vermilion-deep p-6 md:m-8">
        <p className="text-sm text-vermilion-deep">{error}</p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return <BrailleSpinner label="Loading analytics" className="m-8 text-ink" />;

  if (data.submitted < 1) {
    return (
      <div className="px-4 py-8 md:px-8">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Analytics</p>
        <h2 className="mt-2 text-3xl leading-none font-semibold tracking-tight">No submissions yet</h2>
        <p className="mt-4 max-w-prose border border-rule p-6 text-ink-soft">
          Analytics appear after the first candidate submits. Until then there is nothing to summarise.
        </p>
      </div>
    );
  }

  const passing = passPercent(data.passRate);
  // Pass rate is informational cobalt. Reliability below 0.7 is a number that needs a look, so it takes amber.
  const kpis: Array<[string, string, string | undefined, "info" | "caution" | undefined]> = [
    ["Attempts", String(data.attempts), `${data.submitted} submitted`, undefined],
    ["Mean", formatPercent(data.mean, 1), undefined, undefined],
    ["Median", formatPercent(data.median, 1), undefined, undefined],
    ["Std dev", formatMarks(data.stdDev), "Spread of percentages", undefined],
    ["Pass rate", formatPercent(passing, 0), undefined, "info"],
    [
      "Reliability",
      data.reliability === null ? "—" : data.reliability.toFixed(2),
      undefined,
      data.reliability !== null && data.reliability < 0.7 ? "caution" : undefined,
    ],
  ];

  return (
    <div className="grid gap-14 px-4 py-8 md:px-8">
      <header>
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Analytics</p>
        <h2 id={headingId} className="mt-2 text-3xl leading-none font-semibold tracking-tight md:text-4xl">
          How the exam performed
        </h2>
      </header>

      <section aria-label="Summary" className="grid gap-6">
        <StatGrid columns={6}>
          {kpis.map(([label, value, note, tone]) => (
            <Stat key={label} label={label} value={value} note={note} tone={tone} />
          ))}
        </StatGrid>
        <p className="max-w-prose text-sm text-ink-soft">{reliabilityNote(data.reliability)}</p>
        <p className="font-mono text-[11px] text-ink-muted">
          Highest {formatPercent(data.highest, 1)} · Lowest {formatPercent(data.lowest, 1)}
        </p>
      </section>

      <div className="grid gap-12 lg:grid-cols-2">
        <section aria-label="Score distribution" className="grid content-start gap-4">
          <h3 className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Distribution</h3>
          <BarChart
            label="Number of candidates by percentage band"
            data={data.histogram.map((bucket) => ({
              key: `${bucket.from}–${bucket.to}%`,
              value: bucket.count,
              // The band the mean falls in is the highlight; the rest of the distribution stays ink.
              tone: data.mean >= bucket.from && data.mean < bucket.to ? "info" : undefined,
            }))}
            formatValue={(value) => `${value} candidates`}
          />
        </section>

        <section aria-labelledby={`${headingId}-topics`} className="grid content-start gap-4">
          <h3 id={`${headingId}-topics`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            Topic performance
          </h3>
          {data.topics.length === 0 ? (
            <p className="text-sm text-ink-muted">No topics are linked to these questions.</p>
          ) : (
            <ul className="grid gap-4">
              {data.topics.map((topic) => (
                <li key={topic.topic} className="grid gap-2">
                  <div className="flex flex-wrap justify-between gap-2 font-mono text-xs">
                    <span className="font-medium">{topic.topic}</span>
                    <span className="text-ink-soft">
                      {formatPercent(topic.meanPercent, 1)} mean · {topic.items} {topic.items === 1 ? "item" : "items"}
                    </span>
                  </div>
                  <div aria-hidden="true" className="h-2 bg-paper-sunk">
                    <div className="h-full bg-ink" style={{ width: `${clamp(topic.meanPercent)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby={`${headingId}-items`} className="grid gap-5">
        <div>
          <h3 id={`${headingId}-items`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            Item analysis
          </h3>
          <p className="mt-2 max-w-prose text-sm text-ink-soft">
            Facility is the share of marks earned. Discrimination compares the top and bottom groups. Expand an item to
            see how each option was chosen.
          </p>
        </div>
        <ItemAnalysis items={data.items} />
      </section>

      <section aria-labelledby={`${headingId}-pairs`} className="grid gap-5">
        <div>
          <h3 id={`${headingId}-pairs`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            Similar answers (indicator)
          </h3>
          <p className="mt-2 max-w-prose text-sm text-ink-soft">
            Pairs of candidates who gave the same wrong answer on many questions. This is a pattern for a person to
            review. It is not evidence of collusion. Shared study groups and common misconceptions can produce it too.
          </p>
        </div>
        {data.similarPairs.length === 0 ? (
          <p className="border border-rule p-4 text-sm text-ink-muted">No unusual pairs found.</p>
        ) : (
          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="sr-only">Candidate pairs with identical wrong answers</caption>
              <thead className="bg-paper-sunk">
                <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                  <th scope="col" className="px-3 py-3 font-medium">First candidate</th>
                  <th scope="col" className="px-3 py-3 font-medium">Second candidate</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Identical wrong answers</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.similarPairs.map((pair) => (
                  <tr key={`${pair.a}-${pair.b}`} className="border-t border-rule">
                    <th scope="row" className="px-3 py-3 font-normal">{pair.a}</th>
                    <td className="px-3 py-3">{pair.b}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{pair.identicalWrong}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatPercent(pair.ratio * 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
