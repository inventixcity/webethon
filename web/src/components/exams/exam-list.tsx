"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/feedback/toaster";
import { api } from "@/lib/api/client";
import { messageFor } from "@/lib/errors/describe";
import type { ExamStatus, ExamSummary, Page } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { formatWindow, PHASE_LABEL, STATUS_LABEL } from "./format";
import { PhaseChip } from "./phase-chip";
import { EmptyState, ErrorState, LoadingState } from "./states";

const FILTERS: Array<{ value: ExamStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

/** Every exam the signed-in examiner owns (all exams for an admin), filtered by status, with cursor paging. */
export function ExamList() {
  const toast = useToast();
  const [status, setStatus] = useState<ExamStatus | "all">("all");
  const [items, setItems] = useState<ExamSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    const query = params.toString();
    setLoading(true);
    setError(null);
    api<Page<ExamSummary>>(`/exams${query ? `?${query}` : ""}`)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [status, attempt]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor });
      if (status !== "all") params.set("status", status);
      const page = await api<Page<ExamSummary>>(`/exams?${params.toString()}`);
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="exam-list-heading" className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h2 id="exam-list-heading" className="sr-only">
          Exams
        </h2>
        <div role="group" aria-label="Filter exams by status" className="flex max-w-full overflow-x-auto border border-ink bg-paper-raised">
          {FILTERS.map((filter) => {
            const active = status === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={active}
                onClick={() => setStatus(filter.value)}
                className={cn(
                  "relative h-11 border-r border-ink px-5 font-mono text-[12.5px] font-semibold tracking-[0.1em] whitespace-nowrap uppercase transition-colors duration-(--duration-fast) ease-(--ease-enter) last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cobalt",
                  "after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-cobalt after:transition-transform after:duration-(--duration-fast)",
                  active ? "bg-ink text-paper after:scale-x-100" : "text-ink-soft after:scale-x-0 hover:bg-paper-sunk hover:text-ink",
                )}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
        <Button asChild>
          <Link href="/app/examiner/exams/new">New exam</Link>
        </Button>
      </div>

      {loading ? <LoadingState label="Loading exams" rows={4} /> : null}

      {!loading && error ? <ErrorState error={error} onRetry={() => setAttempt((value) => value + 1)} /> : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState
          art="empty-exams"
          title={status === "all" ? "No exams yet." : `No ${STATUS_LABEL[status].toLowerCase()} exams.`}
          action={
            status === "all" ? (
              <Button asChild variant="secondary">
                <Link href="/app/examiner/exams/new">Create the first exam</Link>
              </Button>
            ) : null
          }
        >
          {status === "all" ? "Create an exam to start assigning questions and enrolling candidates." : "Try another filter."}
        </EmptyState>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <>
          <ul aria-label="Exam list" className="grid">
            {items.map((exam) => (
              <ExamListItem key={exam.id} exam={exam} />
            ))}
          </ul>
          {cursor ? (
            <div className="flex justify-center border-t border-rule pt-8">
              <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** One exam as a row: title and window, phase and status, then the counts. Reused on the overview page. */
export function ExamListItem({ exam }: { exam: ExamSummary }) {
  return (
    <li className="grid gap-5 border-t border-rule py-6 md:grid-cols-12 md:items-center">
      <div className="grid min-w-0 gap-2 md:col-span-5">
        <Link
          href={`/app/examiner/exams/${encodeURIComponent(exam.id)}`}
          className="text-xl leading-snug font-medium tracking-[-0.01em] break-words underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
        >
          {exam.title}
        </Link>
        <p className="text-sm text-ink-soft">{formatWindow(exam.startsAt, exam.endsAt)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 md:col-span-3">
        <PhaseChip phase={exam.phase} />
        {STATUS_LABEL[exam.status].toLowerCase() !== PHASE_LABEL[exam.phase].toLowerCase() ? (
          <span className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">{STATUS_LABEL[exam.status]}</span>
        ) : null}
      </div>

      <dl className="grid grid-cols-3 gap-3 md:col-span-4">
        <Count label="Questions" value={exam.questionCount} />
        <Count label="Enrolled" value={exam.enrolledCount} />
        <Count label="Attempts" value={exam.attemptCount} />
      </dl>
    </li>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-1 border-l border-rule pl-3">
      <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}
