"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api/client";
import { attemptHeaders } from "@/lib/exam/device";
import type { ExamLobby as Lobby } from "@/lib/exam/types";
import { AccessChip } from "./candidate-dashboard";
import { describeError, formatDuration, formatWindow } from "./format";
import { PanelError, PanelLoading } from "./notice";
import { useApiData } from "./use-api-data";

const RECORDED = [
  "Window focus changes: when the exam tab loses focus or is hidden.",
  "Fullscreen exits, when the exam asks for fullscreen.",
  "Paste sizes: how many characters were pasted, never what they were.",
  "Device changes, when the exam is opened on another device.",
  "Connection drops: when you went offline and when you came back.",
];

const NOT_RECORDED = [
  "Your camera, microphone or screen. Nothing is recorded from them.",
  "The content of your keystrokes. Typing is never logged as text.",
];

/** A labelled block in the lobby. Each one is a region a screen reader can jump to. */
function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 border-t border-ink py-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-10"
    >
      <h2 id={id} className="font-mono text-[11px] tracking-[0.14em] uppercase">
        {title}
      </h2>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function Mark({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={filled ? "mt-2.5 size-1.5 shrink-0 bg-amber" : "mt-2.5 size-1.5 shrink-0 border border-amber-deep"}
    />
  );
}

/** Why the exam can't be started yet, in words. Before the window opens it counts down and reloads at zero. */
function LobbyReason({ reason, startsAt, onOpen }: { reason: string | null; startsAt: string; onOpen: () => void }) {
  const opensAt = new Date(startsAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  const waiting = reason === "not_started" && Number.isFinite(opensAt);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= opensAt + 1500) {
        window.clearInterval(timer);
        onOpen();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waiting, opensAt, onOpen]);

  let message: string;
  if (waiting) {
    const left = Math.max(0, Math.floor((opensAt - now) / 1000));
    const hh = String(Math.floor(left / 3600)).padStart(2, "0");
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
    const ss = String(left % 60).padStart(2, "0");
    const at = new Date(opensAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    message = left > 0 ? `This exam opens in ${hh}:${mm}:${ss} (${at}). You can start it then; this page updates itself.` : "Opening now…";
  } else if (reason === "late_join_closed") {
    message = "Late joining has closed for this exam. Contact your examiner if you think this is wrong.";
  } else if (reason === "attempt_exists") {
    message = "You have already submitted this exam. Your result appears on My exams once it is published.";
  } else if (reason === "closed") {
    message = "This exam has closed.";
  } else {
    message = "You can't start this exam right now.";
  }
  return (
    <p className="flex items-center gap-3 text-sm tracking-normal normal-case">
      <span aria-hidden="true" className={waiting ? "size-1.5 shrink-0 animate-pulse bg-cobalt" : "size-1.5 shrink-0 bg-vermilion"} />
      {message}
    </p>
  );
}

export function ExamLobby({ examId }: { examId: string }) {
  const router = useRouter();
  const { state, reload } = useApiData<Lobby>(`/me/exams/${examId}`);
  const [agreed, setAgreed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const checkId = useId();

  if (state.status === "loading") return <PanelLoading label="Loading the lobby" />;  if (state.status === "error") {
    return (
      <div className="grid gap-6">
        <PanelError title="We couldn't open this exam." message={describeError(state.error)} onRetry={reload} />
        <Link
          href="/app/candidate"
          className="w-fit font-mono text-[11px] tracking-[0.12em] uppercase underline underline-offset-4"
        >
          Back to my exams
        </Link>
      </div>
    );
  }

  const lobby = state.data;
  const resuming = lobby.access === "in_progress" && Boolean(lobby.attemptId);
  // Resuming is always allowed: the workspace re-checks the device and the deadline.
  const canProceed = lobby.canStart || resuming;
  const integrity = lobby.settings.integrity;

  async function start() {
    setStarting(true);
    setStartError(undefined);
    if (resuming && lobby.attemptId) {
      router.push(`/exam/${lobby.attemptId}`);
      return;
    }
    try {
      // The device id travels in a header, so the server knows which device holds this attempt.
      const { attemptId } = await api<{ attemptId: string }>(`/me/exams/${examId}/attempt`, {
        method: "POST",
        headers: attemptHeaders(),
      });
      router.push(`/exam/${attemptId}`);
    } catch (cause) {
      setStartError(describeError(cause));
      setStarting(false);
    }
  }

  return (
    <div className="grid gap-12">
      <PageHeader
        index="02"
        eyebrow="Exam lobby"
        banner="bg-candidate"
        title={lobby.title}
        breadcrumb={[{ label: "My exams", href: "/app/candidate" }, { label: lobby.title }]}
      >
        <div>
          <AccessChip access={lobby.access} />
        </div>
      </PageHeader>

      <dl className="grid gap-px border-y border-rule font-mono text-[11px] tracking-[0.12em] uppercase sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-2 py-5 sm:pr-6">
          <dt className="text-ink-muted">Window</dt>
          <dd className="normal-case tracking-normal">{formatWindow(lobby.startsAt, lobby.endsAt)}</dd>
        </div>
        <div className="grid gap-2 py-5 sm:pl-6 lg:px-6">
          <dt className="text-ink-muted">Duration</dt>
          <dd className="normal-case tracking-normal">
            {formatDuration(lobby.durationMinutes)}
            {lobby.extraMinutes > 0 && (
              <span className="block text-ink-soft">Includes {lobby.extraMinutes} extra min (accommodation)</span>
            )}
          </dd>
        </div>
        <div className="grid gap-2 py-5 sm:pr-6 lg:px-6">
          <dt className="text-ink-muted">Questions</dt>
          <dd className="normal-case tracking-normal">{lobby.questionCount}</dd>
        </div>
        <div className="grid gap-2 py-5 sm:pl-6 lg:pl-6">
          <dt className="text-ink-muted">Total marks</dt>
          <dd className="normal-case tracking-normal">{lobby.totalMarks}</dd>
        </div>
      </dl>

      <Block id="instructions" title="Instructions">
        <p className="max-w-[68ch] text-base leading-relaxed whitespace-pre-line">
          {lobby.instructions.trim() || "Your institution has not added instructions for this exam."}
        </p>
      </Block>

      <Block id="what-is-recorded" title="What is recorded">
        <p className="max-w-[68ch] text-base text-ink-soft">
          Your exam records a few browser signals so your institution can review the session. They are indicators
          for review, not evidence of cheating, and no decision is made from them alone.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <h3 className="font-mono text-[11px] tracking-[0.12em] uppercase">Recorded</h3>
            <ul className="grid gap-2 text-base text-ink-soft">
              {RECORDED.map((item) => (
                <li key={item} className="flex gap-3">
                  <Mark filled />
                  {item}
                </li>
              ))}
              {integrity.fullscreen && (
                <li className="flex gap-3">
                  <Mark filled />
                  This exam asks for fullscreen, so fullscreen exits are counted.
                </li>
              )}
            </ul>
          </div>
          <div className="grid content-start gap-3">
            <h3 className="font-mono text-[11px] tracking-[0.12em] uppercase">Not recorded</h3>
            <ul className="grid gap-2 text-base text-ink-soft">
              {NOT_RECORDED.map((item) => (
                <li key={item} className="flex gap-3">
                  <Mark filled={false} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Block>

      <Block id="connection" title="If your connection drops">
        <p className="max-w-[68ch] text-base leading-relaxed text-ink-soft">
          {lobby.settings.allowOfflineJournal
            ? "Your answers are kept on this device in a tamper-evident journal while you are offline, and sent to the server when you reconnect. The server checks every entry. Nothing is lost if the connection drops or the device restarts."
            : "This exam needs a connection. Each answer is saved to the server as you go."}
        </p>
        <p className="max-w-[68ch] text-base leading-relaxed text-ink-soft">
          The deadline is kept by the server and is never paused automatically. Time lost to a verified outage is
          credited only if your examiner approves it.
        </p>
      </Block>

      <section aria-labelledby="start-exam" className="grid gap-6 border-t border-ink py-8">
        <h2 id="start-exam" className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Start
        </h2>
        <div className="flex items-start gap-4">
          <Checkbox
            id={checkId}
            checked={agreed}
            onCheckedChange={(value) => setAgreed(value === true)}
            disabled={starting}
            className="mt-0.5 size-10 shrink-0"
          />
          <Label htmlFor={checkId} className="cursor-pointer text-base leading-snug tracking-normal normal-case">
            I have read the instructions.
          </Label>
        </div>

        <div aria-live="polite" className="min-h-5 font-mono text-[11px] tracking-[0.04em]">
          {!canProceed && <LobbyReason reason={lobby.reason} startsAt={lobby.startsAt} onOpen={reload} />}
        </div>
        {startError && (
          <p role="alert" className="flex items-center gap-3 font-mono text-[11px] tracking-[0.04em]">
            <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
            {startError}
          </p>
        )}

        <div>
          <Button
            type="button"
            size="lg"
            disabled={!agreed || !canProceed || starting}
            loading={starting}
            onClick={start}
          >
            {resuming ? "Resume exam" : "Start exam"}
          </Button>
        </div>
      </section>
    </div>
  );
}
