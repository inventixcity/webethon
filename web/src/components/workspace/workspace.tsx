"use client";

import { setSimulatedOffline } from "@/lib/exam/network";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PageLoader } from "@/components/loaders/page-loader";
import { Toaster, useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { deviceId as readDeviceId } from "@/lib/exam/device";
import { CANDIDATE_NOTICE, requestExamFullscreen, startIntegrity } from "@/lib/exam/integrity";
import { useNetworkStatus } from "@/lib/exam/network";
import { useAttempt } from "@/lib/exam/use-attempt";
import type { AttemptPayload, ExamSettings } from "@/lib/exam/types";
import { AnnouncementsPanel, useAnnouncementToasts } from "./announcements";
import { Palette, PaletteTrigger, type PaletteItem } from "./palette";
import { PrefsDrawer } from "./prefs-drawer";
import { ConnectionBanner, JournalRejectedNotice } from "./network-banner";
import { Question, questionDomId } from "./question";
import {
  effectiveState,
  emptyResponse,
  isAnswered,
  parseRejectedReasons,
  summarizeSaves,
  type AttemptView,
  type JournalRejectReason,
} from "./model";
import { usePrefs } from "./use-prefs";
import { WorkspaceRootContext } from "./drawer";
import { Scratchpad } from "./scratchpad";
import { SubmitDialog } from "./submit-dialog";
import { TopBar } from "./top-bar";
import "./workspace.css";

/**
 * The examination workspace (3.5, 4.1, 4.7, 4.8). One client container owns the engine (`useAttempt`), the
 * integrity collector and the preferences. Everything it renders is a presentational component under
 * `./`, so each piece can be read and tested on its own.
 */
export function ExamWorkspace({ attemptId }: { attemptId: string }) {
  const attempt: AttemptView = useAttempt(attemptId);

  if (attempt.payload === null) {
    if (attempt.status === "error") return <LoadError error={attempt.error} />;
    return <PageLoader label="Loading your exam" />;
  }

  return <Workspace attemptId={attemptId} attempt={attempt} payload={attempt.payload} />;
}

function Workspace({
  attemptId,
  attempt,
  payload,
}: {
  attemptId: string;
  attempt: AttemptView;
  payload: AttemptPayload;
}) {
  const toast = useToast();
  const network = useNetworkStatus();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const { prefs, update: updatePrefs } = usePrefs(() =>
    toast.error("Your preferences could not be saved to your account. They are kept on this device."),
  );

  const [index, setIndex] = useState(0);
  const [entered, setEntered] = useState(!payload.settings.integrity.fullscreen);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rejectionDismissed, setRejectionDismissed] = useState<string | null>(null);
  // Demo aid for sandbox attempts (5.3). useAttempt does not expose a simulate-offline hook yet, so this stays
  // false and the toggle does nothing. Wire it to the engine hook when that lands.
  const [simulated, setSimulated] = useState(false);
  // Never leave the simulated outage on after leaving the workspace.
  useEffect(() => () => setSimulatedOffline(false), []);
  const scrollRef = useRef<HTMLElement>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  const items = payload.items;
  const count = items.length;
  const safeIndex = Math.max(0, Math.min(index, count - 1));
  const ended = attempt.closed || submitted || payload.status !== "in_progress";
  const returnHref = payload.sandbox ? `/app/examiner/exams/${payload.examId}` : "/app/candidate";
  const returnLabel = payload.sandbox ? "Back to the exam" : "Back to your exams";
  const { toggleFlag, setAnswer } = attempt;

  // The device id lives in localStorage, so it is read only after mount.
  useEffect(() => {
    setDeviceId(readDeviceId() || null);
  }, []);

  // Integrity collector (5.1). Settings are keyed by value, so a new payload object does not restart it.
  const settingsKey = JSON.stringify(payload.settings);
  useEffect(() => {
    if (!deviceId) return;
    const settings = JSON.parse(settingsKey) as ExamSettings;
    return startIntegrity({
      attemptId,
      deviceId,
      settings,
      onWarning: (message) => toast.info(message),
    });
  }, [attemptId, deviceId, settingsKey, toast]);

  useAnnouncementToasts(attempt.announcements, (body) => toast.info(`Examiner announcement: ${body}`));

  // Leaving with unsynced answers would lose them only if they never reach the server, so warn only then.
  const pending = attempt.pendingCount > 0;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const paletteItems: PaletteItem[] = items.map((item, position) => {
    const entry = attempt.answers[item.id];
    const state = entry ? effectiveState(entry.state, attempt.pendingCount) : null;
    return {
      id: item.id,
      index: position,
      answered: isAnswered(entry?.response),
      flagged: entry?.flagged ?? false,
      failed: entry?.state === "error",
      queued: state === "queued" || state === "offline",
    };
  });
  const answeredCount = paletteItems.filter((item) => item.answered).length;
  const saves = summarizeSaves(attempt.answers, attempt.pendingCount, !network.online, submitting);

  // Journal entries the server refused (5.3). Prefer the hook's structured list; fall back to its error text.
  const rejected = attempt.journalRejected ?? [];
  const rejectedReasons: JournalRejectReason[] =
    rejected.length > 0 ? [...new Set(rejected.map((entry) => entry.reason))] : parseRejectedReasons(attempt.error);
  const rejectedQuestions = [
    ...new Set(rejected.map((entry) => items.findIndex((item) => item.id === entry.itemId)).filter((index) => index >= 0)),
  ].sort((a, b) => a - b);
  const rejectionKey = `${rejectedReasons.join(",")}|${rejectedQuestions.join(",")}`;

  const goTo = useCallback(
    (next: number) => {
      const target = Math.max(0, Math.min(next, count - 1));
      setIndex(target);
      // After the state update has painted, bring the question into view and move focus to it.
      requestAnimationFrame(() => {
        const element = document.getElementById(questionDomId(target));
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        element?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
        element?.focus({ preventScroll: true });
      });
    },
    [count],
  );

  // Alt+N, Alt+P and Alt+F work in both layouts. Codes are used, so the shortcuts hold on any keyboard layout.
  // The remaining shortcuts are the ones listed in the help popover: Alt+J palette, Alt+S scratchpad,
  // Alt+R review, Alt+K help. Every shortcut uses Alt.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey) return;
      // Alt only: plain keys belong to the screen reader and to typing, so there are no single-key shortcuts.
      if (!event.altKey) return;
      const item = items[safeIndex];
      switch (event.code) {
        case "KeyN":
          event.preventDefault();
          goTo(safeIndex + 1);
          break;
        case "KeyP":
          event.preventDefault();
          goTo(safeIndex - 1);
          break;
        case "KeyF":
          if (!item) break;
          event.preventDefault();
          toggleFlag(item.id);
          break;
        case "KeyJ": {
          event.preventDefault();
          // The side palette is always visible on large screens, so focus it there; otherwise open the sheet.
          const current = document.querySelector<HTMLElement>('aside[aria-label="Question palette"] [data-current="true"]');
          if (current && current.offsetParent !== null) current.focus();
          else setSheetOpen(true);
          break;
        }
        case "KeyS":
          event.preventDefault();
          setScratchOpen(true);
          break;
        case "KeyR":
          event.preventDefault();
          setSubmitOpen(true);
          break;
        case "KeyK":
          event.preventDefault();
          setHelpOpen((open) => !open);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, safeIndex, goTo, toggleFlag]);

  // Scroll layout: the question nearest the top third of the column is the current one.
  const layout = prefs.layout;
  useEffect(() => {
    if (layout !== "scroll") return;
    const container = scrollRef.current;
    if (!container) return;
    const current = document.getElementById(questionDomId(indexRef.current));
    current?.scrollIntoView({ block: "start" });
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const position = Number((entry.target as HTMLElement).dataset.questionIndex);
          if (!Number.isNaN(position)) setIndex(position);
        }
      },
      { root: container, rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    container.querySelectorAll<HTMLElement>("[data-question-index]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [layout, count]);

  // useAttempt's submit() reports failure through its error field and success through `closed`, so the
  // dialog waits for one of those to change. A failure that was already showing before the click does not count.
  const submitWaiter = useRef<{ resolve: () => void; reject: () => void; errorAtStart: unknown } | null>(null);
  useEffect(() => {
    const waiter = submitWaiter.current;
    if (waiter && attempt.closed) {
      submitWaiter.current = null;
      waiter.resolve();
    }
  }, [attempt.closed]);
  useEffect(() => {
    const waiter = submitWaiter.current;
    if (waiter && attempt.error !== null && attempt.error !== waiter.errorAtStart) {
      submitWaiter.current = null;
      waiter.reject();
    }
  }, [attempt.error]);
  const { submit: submitAttempt } = attempt;
  const submitExam = useCallback(() => {
    setSubmitting(true);
    return new Promise<void>((resolve, reject) => {
      submitWaiter.current = { resolve, reject, errorAtStart: attempt.error };
      void submitAttempt();
    }).finally(() => setSubmitting(false));
  }, [attempt.error, submitAttempt]);

  // The timer's total is the span from the server's start to its deadline (accommodations included).
  const totalMs = Math.max(0, Date.parse(payload.deadlineAt) - Date.parse(payload.startedAt));

  // Sandbox-only demo of 5.3: drives the same offline journal and reconnect paths as a real outage.
  function toggleSimulation() {
    if (!payload.sandbox) return;
    const next = !simulated;
    setSimulated(next);
    setSimulatedOffline(next);
  }

  async function takeOver() {
    setTakingOver(true);
    try {
      await attempt.takeover();
    } catch {
      toast.error("We could not move this attempt to this device. Try again.");
    } finally {
      setTakingOver(false);
    }
  }

  async function enterExam() {
    if (root) await requestExamFullscreen(root);
    // Denied fullscreen is fine: the exam still works, and the integrity collector still records exits.
    setEntered(true);
  }

  const palette = (
    <Palette
      items={paletteItems}
      currentIndex={safeIndex}
      side={prefs.paletteSide}
      onSelect={goTo}
      sheetOpen={sheetOpen}
      onSheetOpenChange={setSheetOpen}
    />
  );

  const renderQuestion = (position: number) => {
    const item = items[position];
    if (!item) return null;
    return (
      <Question
        key={item.id}
        item={item}
        index={position}
        total={count}
        entry={attempt.answers[item.id]}
        canary={payload.canary}
        spacing={prefs.lineSpacing}
        onAnswer={(response, typing) => setAnswer(item.id, response, typing)}
        onToggleFlag={() => toggleFlag(item.id)}
        onClear={() => setAnswer(item.id, emptyResponse(item.kind))}
      />
    );
  };

  let body: ReactNode;
  if (attempt.closed && !submitted) {
    body = (
      <StatePanel
        title="Time is up."
        action={
          <Button asChild>
            <Link href={returnHref}>{returnLabel}</Link>
          </Button>
        }
      >
        Your answers have been submitted.
      </StatePanel>
    );
  } else if (ended) {
    body = (
      <StatePanel
        title="Submitted."
        action={
          <Button asChild>
            <Link href={returnHref}>{returnLabel}</Link>
          </Button>
        }
      >
        Your answers have been submitted.
      </StatePanel>
    );
  } else if (!attempt.deviceActive) {
    body = (
      <StatePanel
        title="This exam is open on another device"
        action={
          <Button type="button" onClick={takeOver} loading={takingOver}>
            Continue on this device
          </Button>
        }
      >
        Your answers are safe. To continue here, take over this attempt. The other device will stop saving.
      </StatePanel>
    );
  } else {
    body = (
      <>
        <TopBar
          title={payload.examTitle}
          sandbox={payload.sandbox}
          remainingMs={attempt.remainingMs}
          totalMs={totalMs}
          timerStyle={prefs.timerStyle}
          saveState={saves.state}
          queued={saves.queued}
          failed={saves.failed.length}
          answered={answeredCount}
          total={count}
          simulated={simulated}
          helpOpen={helpOpen}
          onHelpOpenChange={setHelpOpen}
          onToggleSimulation={toggleSimulation}
          onScratchpad={() => setScratchOpen(true)}
          onPreferences={() => setPrefsOpen(true)}
          onReview={() => setSubmitOpen(true)}
        />
        <ConnectionBanner
          mode={network.quality === "good" ? "online" : network.quality}
          journalEnabled={payload.journal.enabled}
          simulated={simulated}
          onReconnect={toggleSimulation}
        />
        {rejectedReasons.length > 0 && rejectionKey !== rejectionDismissed && (
          <JournalRejectedNotice
            reasons={rejectedReasons}
            questions={rejectedQuestions}
            onDismiss={() => setRejectionDismissed(rejectionKey)}
          />
        )}
        <AnnouncementsPanel items={attempt.announcements} />
        <div className="flex min-h-0 flex-1">
          {prefs.paletteSide === "left" && palette}
          <main id="ws-questions" ref={scrollRef} aria-label="Questions" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 lg:py-10" style={{ zoom: prefs.fontScale }}>
              <div className="mb-6 lg:hidden">
                <PaletteTrigger
                  currentIndex={safeIndex}
                  total={count}
                  answered={answeredCount}
                  onOpen={() => setSheetOpen(true)}
                />
              </div>
              {count === 0 ? (
                <p className="font-sans text-base text-ink-soft">This exam has no questions.</p>
              ) : layout === "single" ? (
                <>
                  {renderQuestion(safeIndex)}
                  <nav
                    aria-label="Question navigation"
                    className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-(--ws-line) pt-6"
                  >
                    <Button type="button" variant="secondary" onClick={() => goTo(safeIndex - 1)} disabled={safeIndex === 0}>
                      Previous
                    </Button>
                    <p className="hidden font-mono text-[11px] tracking-[0.1em] text-ink-muted uppercase md:block">
                      Alt+N next · Alt+P previous · Alt+F flag
                    </p>
                    {safeIndex < count - 1 ? (
                      <Button type="button" onClick={() => goTo(safeIndex + 1)}>
                        Next
                      </Button>
                    ) : (
                      <Button type="button" variant="secondary" onClick={() => setSubmitOpen(true)}>
                        Review &amp; submit
                      </Button>
                    )}
                  </nav>
                </>
              ) : (
                <>
                  {items.map((_, position) => renderQuestion(position))}
                  <div className="flex justify-end border-t border-(--ws-line) pt-6">
                    <Button type="button" variant="secondary" onClick={() => setSubmitOpen(true)}>
                      Review &amp; submit
                    </Button>
                  </div>
                </>
              )}
            </div>
          </main>
          {prefs.paletteSide === "right" && palette}
        </div>
      </>
    );
  }

  return (
    <WorkspaceRootContext.Provider value={root}>
      <div
        ref={setRoot}
        data-workspace
        data-exam-root
        data-contrast={prefs.contrast}
        data-spacing={prefs.lineSpacing}
        data-theme={prefs.theme === "system" ? undefined : prefs.theme}
        className="flex h-dvh min-h-dvh flex-col overflow-hidden bg-paper text-ink"
      >
        <Toaster />
        <a
          href="#ws-questions"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-60 focus:bg-ink focus:px-4 focus:py-3 focus:font-mono focus:text-xs focus:text-paper focus:uppercase"
        >
          Skip to questions
        </a>

        {body}

        {!ended && attempt.deviceActive && !entered && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ws-enter-title"
            aria-describedby="ws-enter-body"
            className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-paper p-4"
          >
            <div className="grid max-w-xl gap-5 border border-ink p-6 sm:p-8">
              <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Before you begin</p>
              <h2 id="ws-enter-title" className="font-sans text-2xl font-semibold tracking-[-0.02em]">
                Enter the exam in fullscreen
              </h2>
              <p id="ws-enter-body" className="font-sans text-base text-ink-soft">
                {CANDIDATE_NOTICE}
              </p>
              <p className="font-sans text-sm text-ink-soft">
                Fullscreen is requested for focus. If it is refused, the exam still works.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button type="button" autoFocus onClick={enterExam}>
                  Enter exam
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEntered(true)}>
                  Continue without fullscreen
                </Button>
              </div>
            </div>
          </div>
        )}

        <PrefsDrawer open={prefsOpen} onOpenChange={setPrefsOpen} prefs={prefs} onChange={updatePrefs} />
        <Scratchpad attemptId={attemptId} deviceId={deviceId} open={scratchOpen} onOpenChange={setScratchOpen} />
        <SubmitDialog
          open={submitOpen}
          onOpenChange={setSubmitOpen}
          items={paletteItems}
          pendingCount={attempt.pendingCount}
          online={network.online}
          returnHref={returnHref}
          returnLabel={returnLabel}
          onJump={goTo}
          onSubmit={submitExam}
          onSubmitted={() => setSubmitted(true)}
        />
      </div>
    </WorkspaceRootContext.Provider>
  );
}

function StatePanel({
  title,
  action,
  children,
}: {
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="grid flex-1 place-items-center p-6" role="alert">
      <div className="grid max-w-lg gap-5 border border-ink p-6 sm:p-8">
        <h1 className="font-sans text-3xl font-semibold tracking-[-0.03em]">{title}</h1>
        <p className="font-sans text-base text-ink-soft">{children}</p>
        <div>{action}</div>
      </div>
    </main>
  );
}

function LoadError({ error }: { error: unknown }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="grid max-w-lg gap-5 border border-ink p-6 sm:p-8">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Exam</p>
        <h1 className="font-sans text-3xl font-semibold tracking-[-0.03em]">
          {notFound ? "This attempt isn't available" : "We couldn't load this exam"}
        </h1>
        <p className="font-sans text-base text-ink-soft">
          {notFound
            ? "It may have ended, or it may not belong to your account."
            : "Check your connection and try again. Your answers are not lost."}
        </p>
        <div className="flex flex-wrap gap-3">
          {notFound ? (
            <Button asChild>
              <Link href="/app/candidate">Back to your exams</Link>
            </Button>
          ) : (
            <Button type="button" onClick={() => window.location.reload()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
