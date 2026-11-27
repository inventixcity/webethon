"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useApiData } from "@/components/candidate/use-api-data";
import { ApiError } from "@/lib/api/client";
import type { Dispute } from "@/lib/exam/types";
import { DisputeStatusBadge } from "./status";
import { RESOLUTION_LABEL, scoreChangeText, formatDay } from "./format";

/** A compact list of the candidate's own disputes. Renders nothing when there are none. */
export function MyDisputes() {
  const { state, reload } = useApiData<Dispute[]>("/me/disputes");

  if (state.status === "loading") return null;
  // A 404 means the disputes service has nothing to list yet, which is the same as having none.
  if (state.status === "error" && state.error instanceof ApiError && state.error.status === 404) return null;
  if (state.status === "error") {
    return (
      <section aria-labelledby="my-disputes" className="flex flex-wrap items-center gap-3 border-t border-rule pt-6 text-sm text-ink-soft">
        <h2 id="my-disputes" className="sr-only">
          My disputes
        </h2>
        <span>We couldn&apos;t load your disputes.</span>
        <Button type="button" variant="secondary" size="sm" onClick={reload}>
          Try again
        </Button>
      </section>
    );
  }
  if (state.data.length === 0) return null;

  return (
    <section aria-labelledby="my-disputes" className="grid gap-4 border-t border-ink pt-6">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-3">
        <h2 id="my-disputes" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          My disputes
        </h2>
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
          {state.data.length} raised
        </p>
      </div>
      <ul className="grid gap-3">
        {state.data.map((dispute) => {
          const change = scoreChangeText(dispute.scoreBefore, dispute.scoreAfter);
          return (
            <li key={dispute.id} className="grid gap-2 border border-rule bg-paper-raised p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="grid min-w-0 gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <DisputeStatusBadge status={dispute.status} />
                  <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    Question {dispute.position} · raised {formatDay(dispute.createdAt)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm break-words">{dispute.stem}</p>
                {dispute.status !== "open" ? (
                  <p className="text-sm text-ink-soft">
                    {RESOLUTION_LABEL[dispute.resolution]}
                    {change ? ` · ${change}` : ""}
                  </p>
                ) : (
                  <p className="text-sm text-ink-soft">Waiting for your examiner.</p>
                )}
              </div>
              <Link
                href={`/app/candidate/results/${encodeURIComponent(dispute.attemptId)}`}
                className="w-fit font-mono text-[11px] tracking-[0.12em] text-cobalt-deep uppercase underline underline-offset-4 hover:text-ink"
              >
                View result
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
