"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { CandidateDashboard as Dashboard, CandidateExamCard } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { useApiData } from "./use-api-data";
import { useTick, serverOffset } from "./clock";
import { ACCESS_LABEL, describeError, formatClock, formatCountdown, formatDuration, formatWindow } from "./format";
import { EmptyState, PanelError, PanelLoading } from "./notice";

export function AccessChip({ access }: { access: CandidateExamCard["access"] }) {
  const filled = access === "available" || access === "in_progress";
  return (
    <span
      className={cn(
        "inline-flex items-center border px-2 py-1 font-mono text-[11px] tracking-[0.12em] uppercase",
        filled ? "border-ink bg-ink text-paper" : "border-ink text-ink",
      )}
    >
      {ACCESS_LABEL[access]}
    </span>
  );
}

/** The one action a card offers, chosen from what the server says the candidate can do now. */
function CardActions({ card }: { card: CandidateExamCard }) {
  const lobby = `/app/candidate/exams/${card.examId}`;
  switch (card.access) {
    case "available":
      return (
        <Button asChild>
          <Link href={lobby}>Open</Link>
        </Button>
      );
    case "in_progress":
      return card.attemptId ? (
        <Button asChild>
          <Link href={`/exam/${card.attemptId}`}>Resume</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link href={lobby}>Open</Link>
        </Button>
      );
    case "upcoming":
      return (
        <Button asChild variant="secondary">
          <Link href={lobby}>Open</Link>
        </Button>
      );
    case "results":
      return card.attemptId ? (
        <Button asChild variant="secondary">
          <Link href={`/app/candidate/results/${card.attemptId}`}>View result</Link>
        </Button>
      ) : null;
    case "submitted":
      return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Awaiting results</p>;
    case "missed":
      return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Window closed</p>;
  }
}

function ExamCard({ card, serverNow }: { card: CandidateExamCard; serverNow: number }) {
  const startsIn = Date.parse(card.startsAt) - serverNow;
  return (
    <li className="grid gap-5 border-t border-ink py-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-10">
      <div className="grid min-w-0 gap-4">
        <div>
          <AccessChip access={card.access} />
        </div>
        <h3 className="text-2xl leading-tight font-medium tracking-[-0.02em] break-words">{card.title}</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-[11px] tracking-[0.12em] uppercase sm:grid-cols-3">
          <div className="grid gap-1">
            <dt className="text-ink-muted">Window</dt>
            <dd className="normal-case tracking-normal">{formatWindow(card.startsAt, card.endsAt)}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-ink-muted">Duration</dt>
            <dd className="normal-case tracking-normal">{formatDuration(card.durationMinutes)}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-ink-muted">Marks</dt>
            <dd className="normal-case tracking-normal">{card.totalMarks}</dd>
          </div>
        </dl>
        {card.access === "upcoming" && (
          <p className="font-mono text-xs tracking-[0.08em] tabular-nums">
            {startsIn > 0 ? `Starts in ${formatCountdown(startsIn)}` : "Starting now"}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 md:justify-end">
        <CardActions card={card} />
      </div>
    </li>
  );
}

function ExamSection({
  id,
  title,
  note,
  cards,
  empty,
  serverNow,
}: {
  id: string;
  title: string;
  note: string;
  cards: CandidateExamCard[];
  empty: string;
  serverNow: number;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={id} className="text-3xl font-medium tracking-[-0.03em]">
          {title}
        </h2>
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          {cards.length} · {note}
        </p>
      </div>
      {cards.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="grid">
          {cards.map((card) => (
            <ExamCard key={`${card.examId}-${card.attemptId ?? "none"}`} card={card} serverNow={serverNow} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CandidateDashboard() {
  const { state, reload } = useApiData<Dashboard>("/me/exams");
  const now = useTick();

  if (state.status === "loading") return <PanelLoading label="Loading your exams" />;
  if (state.status === "error") {
    return (
      <PanelError
        title="We couldn't load your exams."
        message={describeError(state.error)}
        onRetry={reload}
      />
    );
  }

  const { data, receivedAt } = state;
  // Countdowns use the server's clock: the device clock only supplies the time that has passed since the reply.
  const serverNow = now + serverOffset(data.serverNow, receivedAt);
  const total = data.available.length + data.upcoming.length + data.completed.length;

  return (
    <div className="grid gap-14">
      <header className="grid gap-5">
        <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          <span aria-hidden="true" className="size-1.5 bg-vermilion" />
          01 / My exams
        </p>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h1 className="text-[clamp(2.75rem,8vw,5.5rem)] leading-[0.92] font-medium tracking-[-0.035em]">
            Your exams.
          </h1>
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
            Server time {formatClock(serverNow)}
          </p>
        </div>
        <p className="max-w-[60ch] text-base text-ink-soft">
          {total === 0
            ? "Nothing is scheduled for you yet. Exams appear here once your institution enrols you."
            : "Start an exam from its lobby, or resume one you have already begun. Times come from the server."}
        </p>
      </header>

      <ExamSection
        id="available-now"
        title="Available now"
        note="Open"
        cards={data.available}
        empty="No exam is open for you right now."
        serverNow={serverNow}
      />
      <ExamSection
        id="upcoming"
        title="Upcoming"
        note="Scheduled"
        cards={data.upcoming}
        empty="No upcoming exams."
        serverNow={serverNow}
      />
      <ExamSection
        id="completed"
        title="Completed"
        note="Finished"
        cards={data.completed}
        empty="Completed exams and their results will appear here."
        serverNow={serverNow}
      />
    </div>
  );
}
