"use client";

import Link from "next/link";
import type { ExamSummary, Page } from "@/lib/exam/types";
import { Button } from "@/components/ui/button";
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
      <section aria-labelledby="home-intro" className="grid gap-8 md:grid-cols-12">
        <div className="grid gap-4 md:col-span-7">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">01 / Examiner</p>
          <h1 id="home-intro" className="text-[clamp(2rem,5vw,3.75rem)] leading-[0.95] font-medium tracking-[-0.03em]">
            Your exams
          </h1>
        </div>
        <div className="flex flex-wrap items-start gap-3 md:col-span-5 md:justify-end">
          <Button asChild>
            <Link href="/app/examiner/exams/new">New exam</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/app/examiner/questions">Question bank</Link>
          </Button>
        </div>
      </section>

      <dl className="grid grid-cols-2 gap-px border-y border-rule md:grid-cols-4">
        <Stat label="Exams" value={exams.length} note={data.nextCursor ? "First page" : undefined} />
        <Stat label="Ongoing" value={ongoing.length} />
        <Stat label="Enrolled" value={enrolled} />
        <Stat label="Attempts" value={attempts} />
      </dl>

      <Group title="Ongoing" empty="Nothing is running right now." exams={ongoing} />
      <Group title="Upcoming" empty="No exams are scheduled." exams={upcoming} />
      <Group title="Drafts" empty="No drafts. Start a new exam to create one." exams={drafts} />

      {exams.length === 0 ? (
        <EmptyState title="No exams yet." action={<Button asChild><Link href="/app/examiner/exams/new">Create an exam</Link></Button>}>
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

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="grid gap-2 py-6 md:px-6 md:first:pl-0">
      <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
      <dd className="text-4xl font-medium tracking-[-0.03em] tabular-nums">{value}</dd>
      {note ? <p className="font-mono text-[11px] text-ink-muted uppercase">{note}</p> : null}
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
