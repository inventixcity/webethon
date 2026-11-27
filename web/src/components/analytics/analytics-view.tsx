"use client";

import { useEffect, useId, useState } from "react";
import { api } from "@/lib/api/client";
import type { Exam, ExamAnalytics } from "@/lib/exam/types";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionIntro } from "@/components/exams/section-intro";
import { Stat, StatGrid } from "@/components/ui/stat";
import { formatMarks, formatPercent, messageOf } from "./format";
import { ItemAnalysis } from "./item-analysis";
import { ScoreHistogram } from "./score-histogram";
import { SimilarPairsGraph } from "./similar-pairs-graph";
import { TopicTreemap } from "./topic-treemap";

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
  const [total, setTotal] = useState(0);
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

  // The analytics fields for mean, median, spread and the extremes are raw marks. The exam total turns them into percent.
  useEffect(() => {
    let live = true;
    api<Exam>(`/exams/${examId}`)
      .then((exam) => {
        if (live) setTotal(exam.totalMarks);
      })
      .catch(() => {
        if (live) setTotal(0);
      });
    return () => {
      live = false;
    };
  }, [examId]);

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

  // `submitted` counts timer-expired attempts too. Fall back to `attempts` if the field is absent or zero.
  const submitted = data.submitted || data.attempts;
  if (submitted < 1) {
    return (
      <div className="grid gap-10 px-4 py-8 md:px-8">
        <SectionIntro eyebrow="Analytics" title="No submissions yet" summary="Analytics appear after the first candidate submits." />
        <EmptyState
          art="empty-results"
          eyebrow="Nothing to summarise / 00"
          title="The first submission will fill this page."
          description="Once a candidate submits, the score summary, distribution, topic map and item analysis appear here."
        />
      </div>
    );
  }

  /** Marks to percent of the exam total. Null until the total has loaded. */
  const toPct = (marks: number): number | null => (total > 0 ? (marks / total) * 100 : null);
  /** "27.5 / 29 (94.8%)", or just the marks while the total is still loading. */
  const marksLine = (marks: number): string =>
    total > 0 ? `${formatMarks(marks)} / ${total} (${formatPercent(toPct(marks), 1)})` : `${formatMarks(marks)} marks`;
  /** The percentage note under a marks statistic, for example "54.5% of 29 marks". */
  const markNote = (marks: number): string | undefined =>
    total > 0 ? `${formatPercent(toPct(marks), 1)} of ${total} marks` : undefined;

  const passing = passPercent(data.passRate);
  // Reliability below 0.7 is a number that needs a look, so it takes amber.
  const kpis: Array<[string, string, string | undefined, "info" | "caution" | undefined]> = [
    ["Attempts", String(data.attempts), undefined, undefined],
    ["Mean", formatMarks(data.mean), markNote(data.mean), undefined],
    ["Median", formatMarks(data.median), markNote(data.median), undefined],
    ["Std dev", formatMarks(data.stdDev), markNote(data.stdDev), undefined],
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
      <SectionIntro
        eyebrow="Analytics / 02"
        title="How the exam performed"
        summary={`${data.attempts} attempts analysed. Highest ${marksLine(data.highest)}, lowest ${marksLine(data.lowest)}.`}
      />

      <section aria-label="Summary" className="grid gap-6">
        <StatGrid columns={6}>
          {kpis.map(([label, value, note, tone], index) => (
            <Stat key={label} label={label} value={value} note={note} tone={tone} focal={index === 1} />
          ))}
        </StatGrid>
        <p className="max-w-prose text-sm text-ink-soft">{reliabilityNote(data.reliability)}</p>
      </section>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby={`${headingId}-dist`} className="grid content-start gap-5">
          <h3 id={`${headingId}-dist`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            <span className="text-cobalt-deep tabular-nums">02</span> / Distribution
          </h3>
          <ScoreHistogram buckets={data.histogram} mean={toPct(data.mean) ?? 0} />
        </section>

        <section aria-labelledby={`${headingId}-topics`} className="grid content-start gap-5">
          <h3 id={`${headingId}-topics`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            <span className="text-cobalt-deep tabular-nums">03</span> / Topic performance
          </h3>
          {data.topics.length === 0 ? (
            <p className="text-sm text-ink-muted">No topics are linked to these questions.</p>
          ) : (
            <TopicTreemap topics={data.topics} />
          )}
        </section>
      </div>

      <section aria-labelledby={`${headingId}-items`} className="grid gap-5">
        <div>
          <h3 id={`${headingId}-items`} className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            <span className="text-cobalt-deep tabular-nums">04</span> / Item analysis
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
            <span className="text-amber-deep tabular-nums">05</span> / Similar answers (indicator)
          </h3>
          <p className="mt-2 max-w-prose border-l-2 border-amber pl-4 text-sm text-ink-soft">
            Pairs of candidates who gave the same wrong answer on many questions. This is a pattern for a person to
            review. It is not evidence of collusion. Shared study groups and common misconceptions can produce it too.
          </p>
        </div>
        {data.similarPairs.length === 0 ? (
          <p className="border border-rule p-4 text-sm text-ink-muted">No unusual pairs found.</p>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <SimilarPairsGraph pairs={data.similarPairs} />
            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[420px] text-left text-sm">
                <caption className="sr-only">Candidate pairs with identical wrong answers</caption>
                <thead className="bg-paper-sunk">
                  <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                    <th scope="col" className="px-3 py-3 font-medium">Pair</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Identical wrong</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.similarPairs.map((pair) => (
                    <tr key={`${pair.a}-${pair.b}`} className="border-t border-rule">
                      <th scope="row" className="px-3 py-3 font-normal">
                        {pair.a} <span className="text-ink-muted">and</span> {pair.b}
                      </th>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{pair.identicalWrong}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{formatPercent(pair.ratio * 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
