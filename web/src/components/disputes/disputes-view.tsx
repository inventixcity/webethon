"use client";

import { useState } from "react";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { useApiData } from "@/components/candidate/use-api-data";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionIntro } from "@/components/exams/section-intro";
import { ErrorState } from "@/components/ui/state";
import { ApiError } from "@/lib/api/client";
import type { ExaminerDispute } from "./examiner-types";
import { DisputeCard } from "./dispute-card";

type Filter = "open" | "all";

/**
 * The examiner's dispute queue for one exam. Open disputes first by default; "All" keeps the decided ones for audit.
 * A 404 means the backend has no disputes for this exam yet, so the screen says they will appear here.
 */
export function DisputesView({ examId }: { examId: string }) {
  const [filter, setFilter] = useState<Filter>("open");

  return (
    <div className="grid gap-10 px-4 py-8 md:px-8">
      <SectionIntro
        eyebrow="Disputes / 05"
        title="Disputes"
        summary="Candidates can dispute one mark per question within 7 days of results. Each decision is recorded with the score before and after. Scripts appear by label, never by name."
      >
        <div role="group" aria-label="Show disputes" className="flex gap-2 pt-2">
          <Button variant="secondary" size="sm" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
            Open
          </Button>
          <Button variant="secondary" size="sm" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </Button>
        </div>
      </SectionIntro>

      {/* Keyed by filter so each view starts from its own list rather than showing the last one while it loads. */}
      <DisputeQueue key={filter} examId={examId} filter={filter} />
    </div>
  );
}

function DisputeQueue({ examId, filter }: { examId: string; filter: Filter }) {
  const { state, reload } = useApiData<ExaminerDispute[]>(
    `/exams/${encodeURIComponent(examId)}/disputes?status=${filter}`,
  );
  const [overrides, setOverrides] = useState<Record<string, ExaminerDispute>>({});

  if (state.status === "loading") return <BrailleSpinner label="Loading disputes" className="m-8 text-ink" />;

  if (state.status === "error") {
    if (state.error instanceof ApiError && state.error.status === 404) {
      return (
        <EmptyState
          variant="panel"
          eyebrow="Not yet / 00"
          title="Disputes will appear here"
          description="When a candidate disputes a mark on a published result, it shows up in this queue."
        />
      );
    }
    return <ErrorState error={state.error} onRetry={reload} title="We couldn't load the dispute queue." />;
  }

  const rows = state.data.map((row) => overrides[row.id] ?? row);
  if (rows.length === 0) {
    return (
      <EmptyState
        variant="panel"
        eyebrow={filter === "open" ? "Queue clear / 00" : "No disputes / 00"}
        title={filter === "open" ? "No open disputes." : "No disputes have been raised for this exam."}
        description="Candidates can dispute a mark from their published result for 7 days."
      />
    );
  }

  return (
    <ul className="grid gap-6" aria-label="Disputes">
      {rows.map((row) => (
        <li key={row.id}>
          <DisputeCard
            dispute={row}
            onResolved={(next) => setOverrides((current) => ({ ...current, [next.id]: next }))}
          />
        </li>
      ))}
    </ul>
  );
}
