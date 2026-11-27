"use client";

import { useEffect, useId } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Meter } from "@/components/ui/meter";
import { SectionIntro } from "@/components/exams/section-intro";
import { isNotFound, scoreTone } from "@/components/exams/blueprint-model";
import { useResource } from "@/components/exams/use-resource";
import { LoadingState } from "@/components/exams/states";
import type { Blueprint, FairnessReport } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { FairnessScatter } from "./fairness-scatter";

/**
 * "Fairness across papers" on the analytics page. It shows only when fair papers are on for the exam. A 404 from
 * either endpoint hides the section, because the feature is not there.
 */
export function FairnessSection({ examId, className }: { examId: string; className?: string }) {
  const toast = useToast();
  const headingId = useId();
  const base = `/exams/${encodeURIComponent(examId)}` as const;
  const blueprint = useResource<Blueprint>(`${base}/blueprint`);
  const enabled = blueprint.data?.enabled === true;
  const fairness = useResource<FairnessReport>(enabled ? `${base}/fairness` : null);
  const { reload: reloadFairness } = fairness;

  const fairnessError = fairness.error;
  const fairnessOff = isNotFound(fairnessError);

  useEffect(() => {
    if (fairnessError && !fairnessOff) {
      toast.error("Could not load fairness across papers.", { action: { label: "Try again", onClick: reloadFairness } });
    }
  }, [fairnessError, fairnessOff, reloadFairness, toast]);

  // Hidden while the blueprint is unknown, off, or missing. Showing nothing is the honest state for those.
  if (isNotFound(blueprint.error)) return null;
  if (blueprint.loading && !blueprint.data) {
    return <LoadingState label="Loading fairness" rows={2} className={cn("px-4 md:px-8", className)} />;
  }
  if (!enabled || fairnessOff) return null;

  const report = fairness.data;
  const tone = report ? scoreTone(report.fairnessScore) : "fair";

  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid gap-10 border-t border-rule px-4 pt-10 pb-12 md:px-8", className)}
    >
      <SectionIntro
        eyebrow="Analytics / 06"
        title={<span id={headingId}>Fairness across papers</span>}
        summary="Each candidate sat a different paper drawn from one blueprint. This shows whether those papers were equally hard."
      />

      {fairness.loading && !report ? <LoadingState label="Loading fairness" rows={2} /> : null}

      {!fairness.loading && !report && fairnessError ? (
        <div className="grid max-w-prose justify-items-start gap-3 border-l-2 border-vermilion-deep pl-5">
          <p className="text-sm text-ink-soft">Fairness could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={reloadFairness}>
            Try again
          </Button>
        </div>
      ) : null}

      {report && report.papers === 0 ? (
        <EmptyState
          art="empty-results"
          eyebrow="Nothing to compare / 00"
          title="No attempts yet."
          description="Fairness appears once candidates start this exam. Each candidate's predicted difficulty is then set against their score."
        />
      ) : null}

      {report && report.papers > 0 ? (
        <div className="grid gap-10">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div className="grid content-start gap-6">
              <div className="grid gap-2">
                <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Fairness score</p>
                <p
                  className={cn(
                    "text-[72px] leading-none font-medium tracking-[-0.03em] tabular-nums",
                    tone === "fair" ? "text-cobalt" : "text-amber-deep",
                  )}
                >
                  {report.fairnessScore}
                  <span className="ml-2 font-mono text-base tracking-normal text-ink-muted">/ 100</span>
                </p>
                <Meter
                  value={report.fairnessScore}
                  max={100}
                  tone={tone === "fair" ? "info" : "caution"}
                  label="Fairness score"
                  valueText={`${report.fairnessScore} out of 100`}
                  size="md"
                />
              </div>
              <dl className="grid grid-cols-2 border-t border-rule">
                <div className="grid gap-1 border-r border-rule px-3 py-3">
                  <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Spread</dt>
                  <dd className="text-2xl font-medium tabular-nums">{(report.spread * 100).toFixed(1)} pts</dd>
                </div>
                <div className="grid gap-1 px-3 py-3">
                  <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Papers</dt>
                  <dd className="text-2xl font-medium tabular-nums">{report.papers}</dd>
                </div>
              </dl>
              <p className="max-w-prose text-sm text-ink-soft">
                Each dot is one candidate. The further a dot sits from the dashed line, the more its paper's predicted
                difficulty and the score it earned disagree. A tight cloud means the papers were equally hard.
              </p>
            </div>

            <FairnessScatter rows={report.rows} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
