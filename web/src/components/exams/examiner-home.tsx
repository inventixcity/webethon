"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { BarChart, Sparkline } from "@/components/charts";
import { useTick } from "@/components/candidate/clock";
import { formatCountdown } from "@/components/candidate/format";
import { useToast } from "@/components/feedback/toaster";
import { CtaLink } from "@/components/app-shell/cta-link";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api/client";
import { messageFor } from "@/lib/errors/describe";
import type { ExaminerStats, ExamSummary, Page } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { createSandboxAttempt } from "./actions";
import { EXAM_CHANGED_EVENT, formatWindow, PHASE_LABEL } from "./format";
import { PhaseChip } from "./phase-chip";
import { EmptyState, ErrorState, LoadingState } from "./states";

/**
 * Loads a list and keeps the last good answer on screen while it refreshes. It refetches when the tab regains focus
 * and when any exam changes, so the checklist and the lanes stay live without a loading flash.
 */
function useLive<T>(path: `/${string}`) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api<T>(path).then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) setState((previous) => ({ data: previous.data, error, loading: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const onRefresh = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    window.addEventListener(EXAM_CHANGED_EVENT, onRefresh);
    return () => {
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
      window.removeEventListener(EXAM_CHANGED_EVENT, onRefresh);
    };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { ...state, reload };
}

const byTime = (key: "startsAt" | "endsAt") => (a: ExamSummary, b: ExamSummary) => Date.parse(a[key]) - Date.parse(b[key]);

/** The examiner's cockpit: what is running, what is coming, what waits on results, and the guided flow. */
export function ExaminerHome() {
  const { data, error, reload } = useLive<Page<ExamSummary>>("/exams");
  const stats = useLive<ExaminerStats>("/examiner/stats");
  const [candidateSamples, setCandidateSamples] = useState<Array<{ key: string; value: number }>>([]);

  useEffect(() => {
    if (stats.data) setCandidateSamples((current) => [...current.slice(-18), { key: new Date().toISOString(), value: stats.data!.candidatesNow }]);
  }, [stats.data]);

  if (!data) return error ? <ErrorState error={error} onRetry={reload} /> : <LoadingState label="Loading your exams" rows={4} />;

  const exams = data.items;
  const ongoing = exams.filter((exam) => exam.phase === "ongoing").sort(byTime("endsAt"));
  const upcoming = exams.filter((exam) => exam.phase === "scheduled").sort(byTime("startsAt"));
  const drafts = exams.filter((exam) => exam.status === "draft");
  const toPublish = exams
    .filter((exam) => (exam.phase === "closed" || exam.phase === "completed") && exam.resultsPublishedAt === null && exam.status !== "archived")
    .sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt));
  const enrolled = exams.reduce((sum, exam) => sum + exam.enrolledCount, 0);
  const attempts = exams.reduce((sum, exam) => sum + exam.attemptCount, 0);

  return (
    <div className="grid gap-10">
      <PageHeader
        index="01"
        eyebrow="Examiner"
        banner="bg-examiner"
        title="Overview"
        description="What is running, what is coming, and what still needs you."
        actions={
          <>
            <CtaLink href="/app/examiner/exams/new">New exam</CtaLink>
            <Button asChild variant="secondary">
              <Link href="/app/examiner/questions">Question bank</Link>
            </Button>
          </>
        }
      />

      {exams.length === 0 ? (
        <EmptyState
          art="empty-exams"
          eyebrow="Empty exams / 00"
          title="No exams yet."
          action={
            <Button asChild>
              <Link href="/app/examiner/exams/new">Create an exam</Link>
            </Button>
          }
        >
          Build an exam from your question bank, enrol candidates, then publish when it is ready.
        </EmptyState>
      ) : (
        <>
          <LiveBoard ongoing={ongoing} />
          <section aria-label="Exam activity charts" className="grid gap-6 border border-rule bg-paper-raised p-5 md:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-3 flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase"><LiveDot /> Candidates in exams right now</p>
              <p className="mb-2 text-3xl font-medium tabular-nums">{stats.data?.candidatesNow ?? "—"}</p>
              <Sparkline label="Candidates active during recent 15-second samples" data={candidateSamples.map((point) => ({ key: new Date(point.key).toLocaleTimeString(), value: point.value, tone: "info" as const }))} />
            </div>
            <BarChart label="Submissions per day · last 14 days" data={(stats.data?.submissionsPerDay ?? []).map((row) => ({ key: row.day, value: row.count, tone: "info" as const }))} />
          </section>
          <section className="grid gap-3 border-t border-rule pt-5" aria-labelledby="recent-pass-rates">
            <h2 id="recent-pass-rates" className="font-mono text-[11px] tracking-[0.12em] uppercase">Pass rate · recent completed exams</h2>
            {(stats.data?.passRateByExam ?? []).length === 0 ? <p className="text-sm text-ink-muted">No completed exams with scored submissions yet.</p> : <ul className="grid gap-3">{stats.data?.passRateByExam.map((exam) => <li key={exam.examId} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,2fr)_3rem] sm:items-center"><span className="truncate text-sm">{exam.title}</span><span className="h-2 border border-rule bg-paper-sunk" role="img" aria-label={`${exam.title}: ${(exam.passRate * 100).toFixed(1)} percent pass rate`}><span className="block h-full bg-cobalt" style={{ width: `${Math.max(0, Math.min(100, exam.passRate * 100))}%` }} /></span><span className="font-mono text-xs tabular-nums">{(exam.passRate * 100).toFixed(0)}%</span></li>)}</ul>}
          </section>
          <dl className="grid grid-cols-2 gap-px border border-rule bg-rule md:grid-cols-5">
            <Tile label="Exams" value={exams.length} note={data.nextCursor ? "First page only" : "All exams"} />
            <Tile label="Ongoing" value={ongoing.length} tone="live" note="Running now" />
            <Tile label="Enrolled" value={enrolled} note="Candidates" />
            <Tile label="Attempts" value={attempts} note="Started" />
            <Tile label="Awaiting results" value={toPublish.length} tone="caution" note="Closed, not published" />
          </dl>

          <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
            <div className="grid min-w-0 content-start gap-10 lg:col-span-8">
              <Lane id="ongoing" title="Ongoing now" live count={ongoing.length} empty="Nothing is running right now.">
                {ongoing.map((exam) => (
                  <ExamCard key={exam.id} exam={exam} />
                ))}
              </Lane>
              <Lane id="upcoming" title="Upcoming" count={upcoming.length} empty="No exams are scheduled.">
                {upcoming.map((exam) => (
                  <ExamCard key={exam.id} exam={exam} />
                ))}
              </Lane>
              <DraftList drafts={drafts} />
            </div>

            <aside className="grid min-w-0 content-start gap-10 lg:col-span-4">
              <FlowChecklist exams={exams} />
              <PublishQueue exams={toPublish} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

/** The running exams as a crisp readout: title, then how many candidates have started of those enrolled. */
function LiveBoard({ ongoing }: { ongoing: ExamSummary[] }) {
  return (
    <section aria-label="Live board" className="grid gap-3 border-b border-rule pb-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-start md:gap-8">
      <p className="flex items-center gap-3 pt-1 font-mono text-[11px] tracking-[0.14em] uppercase">
        <LiveDot />
        Live board
      </p>
      {ongoing.length === 0 ? (
        <p className="font-mono text-[12px] tracking-[0.12em] text-ink-muted uppercase">No exam running</p>
      ) : (
        <ul className="grid gap-2">
          {ongoing.slice(0, 3).map((exam) => (
            <li key={exam.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-lg font-medium tracking-[-0.01em] break-words">{exam.title}</span>
              <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
                {exam.attemptCount} of {exam.enrolledCount} started
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LiveDot() {
  return (
    <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
      <span className="absolute inset-0 animate-breathe bg-cobalt" />
      <span className="relative size-1.5 bg-cobalt" />
    </span>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone?: "live" | "caution";
}) {
  return (
    <div className="grid content-between gap-6 bg-paper p-5">
      <dt className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        {tone === "live" ? <LiveDot /> : null}
        {tone === "caution" ? <span aria-hidden="true" className="size-1.5 shrink-0 bg-amber" /> : null}
        {label}
      </dt>
      <dd
        className={cn(
          "text-[clamp(2.5rem,5vw,4.5rem)] leading-none font-medium tracking-[-0.03em] tabular-nums",
          tone === "live" && "text-cobalt-deep",
          tone === "caution" && value > 0 && "text-amber-deep",
        )}
      >
        {value}
      </dd>
      <dd className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{note}</dd>
    </div>
  );
}

function Lane({
  id,
  title,
  count,
  live = false,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  live?: boolean;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div className="flex items-center gap-3 border-b border-ink pb-3">
        {live ? <LiveDot /> : null}
        <h2 id={id} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          {title} <span className="text-ink-muted tabular-nums">({count})</span>
        </h2>
      </div>
      {count === 0 ? <EmptyState variant="inline" title={empty} /> : <ul className="grid gap-4">{children}</ul>}
    </section>
  );
}

function ExamCard({ exam }: { exam: ExamSummary }) {
  const base = `/app/examiner/exams/${encodeURIComponent(exam.id)}`;
  const ongoing = exam.phase === "ongoing";
  return (
    <li className="relative grid gap-5 border border-rule bg-paper-raised py-5 pr-5 pl-7 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1.5", ongoing ? "bg-cobalt" : "bg-ink")} />
      <div className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <PhaseChip phase={exam.phase} />
          {ongoing ? (
            <Countdown to={exam.endsAt} prefix="Closes in" className="text-cobalt-deep" />
          ) : exam.phase === "scheduled" ? (
            <Countdown to={exam.startsAt} prefix="Opens in" />
          ) : null}
        </div>
        <Link
          href={base}
          className="text-xl leading-snug font-medium tracking-[-0.02em] break-words underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
        >
          {exam.title}
        </Link>
        <p className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{formatWindow(exam.startsAt, exam.endsAt)}</p>
        <dl className="flex flex-wrap gap-x-7 gap-y-2">
          <Count label="Questions" value={exam.questionCount} />
          <Count label="Enrolled" value={exam.enrolledCount} />
          <Count label="Attempts" value={exam.attemptCount} />
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Button asChild size="sm">
          <Link href={`${base}/monitor`}>Monitor</Link>
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link href={base}>Edit</Link>
        </Button>
        <PreviewButton examId={exam.id} />
      </div>
    </li>
  );
}

/** A live countdown from the device clock. It only paints time; the server decides when an exam opens or closes. */
function Countdown({ to, prefix, className }: { to: string; prefix: string; className?: string }) {
  const now = useTick();
  const remaining = Date.parse(to) - now;
  return (
    <p className={cn("font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase tabular-nums", className)}>
      {prefix} {remaining > 0 ? formatCountdown(remaining) : "now"}
    </p>
  );
}

function PreviewButton({ examId }: { examId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function preview() {
    setBusy(true);
    try {
      const attemptId = await createSandboxAttempt(examId);
      router.push(`/exam/${encodeURIComponent(attemptId)}`);
    } catch (cause) {
      toast.error(messageFor(cause));
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" loading={busy} onClick={preview}>
      Preview
    </Button>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-1">
      <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function DraftList({ drafts }: { drafts: ExamSummary[] }) {
  return (
    <section aria-labelledby="drafts" className="grid gap-4">
      <div className="flex items-center gap-3 border-b border-ink pb-3">
        <h2 id="drafts" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Drafts <span className="text-ink-muted tabular-nums">({drafts.length})</span>
        </h2>
      </div>
      {drafts.length === 0 ? (
        <EmptyState variant="inline" title="No drafts.">Start a new exam to create one.</EmptyState>
      ) : (
        <ul className="grid">
          {drafts.map((exam) => {
            const base = `/app/examiner/exams/${encodeURIComponent(exam.id)}`;
            return (
              <li key={exam.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-rule py-4">
                <Link href={base} className="min-w-0 truncate font-medium underline-offset-4 hover:underline">
                  {exam.title}
                </Link>
                <Button asChild size="sm" variant="secondary">
                  <Link href={base}>Edit</Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The guided flow. Each step ticks from the live data: the question bank and the exam list. */
function FlowChecklist({ exams }: { exams: ExamSummary[] }) {
  const bank = useLive<Page<{ id: string }>>("/questions?limit=1");
  const bankCount = bank.data?.items.length ?? 0;
  const steps = [
    { label: "Build the question bank", done: bankCount > 0, href: "/app/examiner/questions" },
    { label: "Create an exam", done: exams.length > 0, href: "/app/examiner/exams/new" },
    { label: "Add questions to an exam", done: exams.some((exam) => exam.questionCount > 0), href: "/app/examiner/exams" },
    { label: "Enrol candidates", done: exams.some((exam) => exam.enrolledCount > 0), href: "/app/examiner/exams" },
    { label: "Publish the exam", done: exams.some((exam) => exam.status !== "draft"), href: "/app/examiner/exams" },
    { label: "Publish results", done: exams.some((exam) => exam.resultsPublishedAt !== null), href: "/app/examiner/exams" },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const next = steps.findIndex((step) => !step.done);

  return (
    <section aria-labelledby="flow" className="grid gap-4">
      <div className="flex items-center justify-between gap-4 border-b border-ink pb-3">
        <h2 id="flow" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Guided flow
        </h2>
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted tabular-nums">
          {doneCount} / {steps.length}
        </p>
      </div>
      <ol className="grid">
        {steps.map((step, index) => (
          <li key={step.label} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule py-3">
            <span className="font-mono text-[11px] text-ink-muted tabular-nums">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0 text-sm">
              {!step.done && index === next ? (
                <Link href={step.href} className="font-medium underline underline-offset-4 hover:text-cobalt-deep">
                  {step.label}
                </Link>
              ) : (
                <span className={step.done ? "text-ink-muted" : "text-ink"}>{step.label}</span>
              )}
            </span>
            <span
              className={cn(
                "grid size-6 place-items-center border transition-colors duration-(--duration-base) ease-(--ease-enter)",
                step.done ? "border-ink bg-ink text-paper" : "border-ink-muted",
              )}
            >
              {step.done ? <Check aria-hidden="true" className="size-3.5" /> : null}
              <span className="sr-only">{step.done ? "Done" : "To do"}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Closed exams whose results are not out yet, newest first. */
function PublishQueue({ exams }: { exams: ExamSummary[] }) {
  return (
    <section aria-labelledby="publish-queue" className="grid gap-4">
      <div className="flex items-center gap-3 border-b border-ink pb-3">
        <span aria-hidden="true" className="size-1.5 shrink-0 bg-amber" />
        <h2 id="publish-queue" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Results to publish <span className="text-ink-muted tabular-nums">({exams.length})</span>
        </h2>
      </div>
      {exams.length === 0 ? (
        <EmptyState variant="inline" title="Nothing is waiting.">Closed exams with unpublished results appear here.</EmptyState>
      ) : (
        <ul className="grid">
          {exams.slice(0, 5).map((exam) => (
            <li key={exam.id} className="grid gap-2 border-b border-rule py-4">
              <Link
                href={`/app/examiner/exams/${encodeURIComponent(exam.id)}/results`}
                className="font-medium leading-snug underline-offset-4 hover:underline"
              >
                {exam.title}
              </Link>
              <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
                {PHASE_LABEL[exam.phase]} · {exam.attemptCount} attempts
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
