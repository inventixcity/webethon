"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState as ProductEmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { CandidateDashboard as Dashboard, CandidateExamCard, CandidateResult } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { useApiData } from "./use-api-data";
import { CtaLink } from "@/components/app-shell/cta-link";
import { useTick, serverOffset } from "./clock";
import { ACCESS_LABEL, describeError, formatClock, formatCountdown, formatDuration, formatWindow } from "./format";
import { EmptyState, PanelError, PanelLoading } from "./notice";

export function AccessChip({ access }: { access: CandidateExamCard["access"] }) {
  // Cobalt marks what is running or open now; upcoming is informational; everything else is settled and quiet.
  const live = access === "available" || access === "in_progress";
  const info = access === "upcoming";
  return (
    <span
      className={cn(
        "inline-flex items-center border px-2 py-1 font-mono text-[11px] tracking-[0.12em] uppercase",
        live && "border-cobalt bg-cobalt text-paper",
        info && "border-cobalt text-cobalt-deep",
        !live && !info && "border-rule text-ink-soft",
      )}
    >
      {ACCESS_LABEL[access]}
    </span>
  );
}

const isLive = (card: CandidateExamCard) => card.access === "available" || card.access === "in_progress";

/** The primary action for a card, chosen from what the server says the candidate can do now. */
function CardAction({ card }: { card: CandidateExamCard }) {
  const lobby = `/app/candidate/exams/${encodeURIComponent(card.examId)}`;
  switch (card.access) {
    case "available":
      return (
        <Button asChild size="sm">
          <Link href={lobby}>Open</Link>
        </Button>
      );
    case "in_progress":
      return card.attemptId ? (
        <Button asChild size="sm">
          <Link href={`/exam/${encodeURIComponent(card.attemptId)}`}>Resume</Link>
        </Button>
      ) : (
        <Button asChild size="sm">
          <Link href={lobby}>Open</Link>
        </Button>
      );
    case "upcoming":
      return (
        <Button asChild size="sm" variant="secondary">
          <Link href={lobby}>Lobby</Link>
        </Button>
      );
    case "results":
      return card.attemptId ? (
        <Button asChild size="sm" variant="secondary">
          <Link href={`/app/candidate/results/${encodeURIComponent(card.attemptId)}`}>View result</Link>
        </Button>
      ) : null;
    case "submitted":
      return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Awaiting results</p>;
    case "missed":
      return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Window closed</p>;
  }
}

/** The soonest open or running exam, or else the next one scheduled. The countdown runs on the server's clock. */
function NextUp({ card, serverNow }: { card: CandidateExamCard; serverNow: number }) {
  const live = isLive(card);
  const remaining = (live ? Date.parse(card.endsAt) : Date.parse(card.startsAt)) - serverNow;
  const lobby = `/app/candidate/exams/${encodeURIComponent(card.examId)}`;
  const label = card.access === "in_progress" ? "In progress" : card.access === "available" ? "Open now" : "Next up";
  const startClock = new Date(card.startsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const cta =
    card.access === "in_progress" && card.attemptId ? (
      <CtaLink href={`/exam/${encodeURIComponent(card.attemptId)}`} tone="vermilion" className="w-full sm:w-auto">Resume exam</CtaLink>
    ) : card.access === "available" ? (
      <CtaLink href={lobby} tone="vermilion" className="w-full sm:w-auto">Start exam</CtaLink>
    ) : (
      <Button asChild size="lg" variant="secondary" className="w-full sm:w-auto">
        <Link href={lobby}>Open lobby</Link>
      </Button>
    );

  return (
    <section aria-labelledby="next-up" className="grid gap-6 border border-ink bg-paper-raised p-6 md:p-10">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="size-1.5 bg-vermilion" />
        <h2 id="next-up" className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          Next up <span className="text-ink">/ {label}</span>
        </h2>
      </div>

      <h3 className="text-[clamp(2rem,1.2rem+2.6vw,3rem)] leading-[1] font-medium tracking-[-0.03em] break-words">{card.title}</h3>

      <div className="grid gap-4 border-y border-rule py-5">
        <p className="font-mono text-[12px] tracking-[0.12em] uppercase tabular-nums">
          {label} · from {startClock} · {formatDuration(card.durationMinutes)} · {card.totalMarks} marks
        </p>
        <p className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{formatWindow(card.startsAt, card.endsAt)}</p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{live ? "Closes in" : "Starts in"}</p>
          <p
            className={cn(
              "font-mono text-[clamp(2.25rem,5vw,4.25rem)] leading-none font-medium tracking-[-0.02em] tabular-nums",
              live ? "text-cobalt-deep" : "text-ink",
            )}
          >
            {remaining > 0 ? formatCountdown(remaining) : live ? "0:00:00" : "Starting now"}
          </p>
        </div>
        {cta}
      </div>
    </section>
  );
}

/** A compact card for an exam that is still ahead or open. */
function ScheduledCard({ card, serverNow }: { card: CandidateExamCard; serverNow: number }) {
  const startsIn = Date.parse(card.startsAt) - serverNow;
  return (
    <li className="grid gap-4 border border-rule bg-paper-raised p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <AccessChip access={card.access} />
          <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            {formatDuration(card.durationMinutes)} · {card.totalMarks} marks
          </span>
        </div>
        <h3 className="text-lg leading-snug font-medium tracking-[-0.01em] break-words">{card.title}</h3>
        <p className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{formatWindow(card.startsAt, card.endsAt)}</p>
        {card.access === "upcoming" ? (
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase tabular-nums">
            {startsIn > 0 ? `Starts in ${formatCountdown(startsIn)}` : "Starting now"}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
        <CardAction card={card} />
      </div>
    </li>
  );
}

/** A finished exam. Once results are published it fetches the score, which sets the pass or score badge and the verify link. */
function CompletedCard({ card }: { card: CandidateExamCard }) {
  return (
    <li className="grid gap-4 border border-rule bg-paper-raised p-5">
      {card.resultsPublished && card.attemptId ? <ResultBadge attemptId={card.attemptId} /> : <AccessChip access={card.access} />}
      <h3 className="text-lg leading-snug font-medium tracking-[-0.01em] break-words">{card.title}</h3>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">{formatWindow(card.startsAt, card.endsAt)}</p>
        <CardAction card={card} />
      </div>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "live" | "caution" }) {
  return (
    <div className="grid content-between gap-6 bg-paper p-5">
      <dt className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        {tone === "live" ? <span aria-hidden="true" className="size-1.5 bg-cobalt" /> : null}
        {tone === "caution" ? <span aria-hidden="true" className="size-1.5 bg-amber" /> : null}
        {label}
      </dt>
      <dd className={cn("text-[clamp(2rem,3.4vw,3rem)] leading-none font-medium tracking-[-0.03em] tabular-nums", tone === "live" && "text-cobalt-deep")}>{value}</dd>
    </div>
  );
}

function ResultBadge({ attemptId }: { attemptId: string }) {
  const { state, reload } = useApiData<CandidateResult>(`/me/results/${encodeURIComponent(attemptId)}`);

  if (state.status === "loading") {
    return <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Loading result</span>;
  }
  if (state.status === "error") {
    return (
      <button
        type="button"
        onClick={reload}
        className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase underline underline-offset-4 hover:text-ink"
      >
        {describeError(state.error)} Try again
      </button>
    );
  }

  const result = state.data;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={result.passed ? "outline" : "muted"} dot={result.passed}>
        {result.passed ? "Passed" : "Not passed"}
      </Badge>
      <span className="font-mono text-[11px] tracking-[0.08em] text-ink-soft tabular-nums">
        {result.totalScore} / {result.totalMarks} · {result.percent}%
      </span>
      <Link
        href={`/verify/${encodeURIComponent(result.verifyCode)}`}
        className="font-mono text-[11px] tracking-[0.12em] text-cobalt-deep uppercase underline underline-offset-4 hover:text-ink"
      >
        Verify code
      </Link>
    </div>
  );
}

export function CandidateDashboard() {
  const { state, reload } = useApiData<Dashboard>("/me/exams");
  const now = useTick();

  if (state.status === "loading") return <PanelLoading label="Loading your exams" />;
  if (state.status === "error") {
    return <PanelError title="We couldn't load your exams." message={describeError(state.error)} onRetry={reload} />;
  }

  const { data, receivedAt } = state;
  // Countdowns use the server's clock: the device clock only supplies the time that has passed since the reply.
  const serverNow = now + serverOffset(data.serverNow, receivedAt);
  const total = data.available.length + data.upcoming.length + data.completed.length;

  const byStart = (a: CandidateExamCard, b: CandidateExamCard) => Date.parse(a.startsAt) - Date.parse(b.startsAt);
  const pool = [...data.available, ...data.upcoming].sort(byStart);
  const next = pool.find((card) => card.access === "in_progress") ?? pool.find((card) => card.access === "available") ?? pool[0];
  const scheduled = pool.filter((card) => card !== next);

  return (
    <div className="grid gap-10">
      <PageHeader
        index="01"
        eyebrow="My exams"
        banner="bg-candidate"
        title="Your exams"
        description={
          total === 0
            ? "Nothing is scheduled for you yet. Exams appear here once your institution enrols you."
            : "Start an exam from its lobby, or resume one you have already begun. Times come from the server."
        }
        actions={
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
            Server time {formatClock(serverNow)}
          </p>
        }
      />

      {total === 0 ? (
        <ProductEmptyState
          art="empty-exams"
          eyebrow="No exams / 00"
          title="Nothing is scheduled for you yet."
          description="Exams appear here once your institution enrols you."
        />
      ) : (
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="grid min-w-0 content-start gap-10 lg:col-span-8">
            {next ? (
              <NextUp card={next} serverNow={serverNow} />
            ) : (
              <EmptyState>Nothing is open or scheduled right now.</EmptyState>
            )}

            <section aria-labelledby="scheduled" className="grid gap-4">
              <div className="flex items-baseline justify-between gap-3 border-b border-ink pb-3">
                <h2 id="scheduled" className="font-mono text-[11px] tracking-[0.14em] uppercase">
                  Upcoming
                </h2>
                <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
                  {scheduled.length} scheduled
                </p>
              </div>
              {scheduled.length === 0 ? (
                <EmptyState>No other exams are scheduled.</EmptyState>
              ) : (
                <ul className="grid gap-4">
                  {scheduled.map((card) => (
                    <ScheduledCard key={`${card.examId}-${card.attemptId ?? "none"}`} card={card} serverNow={serverNow} />
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section aria-labelledby="completed" className="grid min-w-0 content-start gap-4 lg:col-span-4">
            <div className="flex items-baseline justify-between gap-3 border-b border-ink pb-3">
              <h2 id="completed" className="font-mono text-[11px] tracking-[0.14em] uppercase">
                Completed
              </h2>
              <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
                {data.completed.length} finished
              </p>
            </div>
            {data.completed.length === 0 ? (
              <EmptyState>Completed exams and their results will appear here.</EmptyState>
            ) : (
              <ul className="grid gap-4">
                {data.completed.map((card) => (
                  <CompletedCard key={`${card.examId}-${card.attemptId ?? "none"}`} card={card} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {total > 0 ? (
        <>
          <dl className="grid grid-cols-3 gap-px border border-rule bg-rule">
            <Stat label="Open now" value={data.available.length} tone="live" />
            <Stat label="Scheduled" value={data.upcoming.length} />
            <Stat label="Completed" value={data.completed.length} tone="caution" />
          </dl>
        </>
      ) : null}
    </div>
  );
}
