"use client";

import Link from "next/link";
import type { ExamSummary, Page } from "@/lib/exam/types";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Stat, StatGrid } from "@/components/ui/stat";
import { useResource } from "./use-resource";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { ExamListItem } from "./exam-list";

/** The examiner's overview: what is running, what is coming, what is still a draft, and the shortcuts. */
export function ExaminerHome() {
  const { data, error, loading, reload } = useResource<Page<ExamSummary>>("/exams");

  if (loading) return <LoadingState label="Loading your exams" rows={4} />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const exams = data.items;
  const ongoing = exams.filter((exam) => exam.phase === "ongoing");
  const upcoming = exams.filter((exam) => exam.phase === "scheduled");
  const drafts = exams.filter((exam) => exam.status === "draft");
  const enrolled = exams.reduce((sum, exam) => sum + exam.enrolledCount, 0);
  const attempts = exams.reduce((sum, exam) => sum + exam.attemptCount, 0);

  return (
    <div className="grid gap-16 py-10">
      <PageHeader
        index="01"
        eyebrow="Examiner"
        title="Your exams"
        actions={
          <>
            <Button asChild>
              <Link href="/app/examiner/exams/new">New exam</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/app/examiner/questions">Question bank</Link>
            </Button>
          </>
        }
      />

      <StatGrid columns={4}>
        <Stat label="Exams" value={exams.length} note={data.nextCursor ? "First page" : undefined} />
        <Stat label="Ongoing" value={ongoing.length} tone="info" />
        <Stat label="Enrolled" value={enrolled} />
        <Stat label="Attempts" value={attempts} />
      </StatGrid>

      <Group title="Ongoing" empty="Nothing is running right now." exams={ongoing} />
      <Group title="Upcoming" empty="No exams are scheduled." exams={upcoming} />
      <Group title="Drafts" empty="No drafts. Start a new exam to create one." exams={drafts} />

      {exams.length === 0 ? (
        <EmptyState
          eyebrow="Empty exams / 00"
          title="No exams yet."
          action={
            <Button asChild>
              <Link href="/app/examiner/exams/new">Create an exam</Link>
            </Button>
          }
        >
          Build an exam from your question bank, then enrol candidates and publish when it is ready.
        </EmptyState>
      ) : null}

      <p className="text-sm text-ink-muted">
        <Link href="/app/examiner/exams" className="underline underline-offset-4 hover:text-ink">
          See all exams
        </Link>
      </p>
    </div>
  );
}

function Group({ title, empty, exams }: { title: string; empty: string; exams: ExamSummary[] }) {
  const headingId = `home-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-4">
      <h3 id={headingId} className="font-mono text-[11px] tracking-[0.14em] uppercase">
        {title} <span className="text-ink-muted">({exams.length})</span>
      </h3>
      {exams.length === 0 ? (
        <p className="border-t border-rule py-6 text-ink-muted">{empty}</p>
      ) : (
        <ul aria-label={`${title} exams`} className="grid">
          {exams.map((exam) => (
            <ExamListItem key={exam.id} exam={exam} />
          ))}
        </ul>
      )}
    </section>
  );
}
