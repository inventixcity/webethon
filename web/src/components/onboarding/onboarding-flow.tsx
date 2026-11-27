"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { Field } from "@/components/auth/field";
import { useToast } from "@/components/feedback/toaster";
import { ErrorPage } from "@/components/errors/error-page";
import { Button } from "@/components/ui/button";
import { showFormError, toastFor } from "@/features/account/errors";
import { updateProfile } from "@/features/account/client";
import { useScreenError } from "@/features/account/use-screen-error";
import {
  answeredCount,
  checkProfile,
  progressFor,
  sanitizeAnswers,
  toggleInterest,
  type Answers,
  type Notifications,
  type ProfileDraft,
} from "@/features/onboarding/answers";
import { getOnboarding, getProfile, saveOnboarding } from "@/features/onboarding/client";
import { onboardingSteps, type OnboardingStep } from "@/features/onboarding/config";
import { durationSeconds, easing, motionTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { createSignalScene, type SignalState } from "./signal-scene";

const FORM_ID = "onboarding-form";
const PROFILE_FIELDS = ["displayName", "avatarUrl"] as const;
const INTEREST_COUNT = onboardingSteps.reduce((total, step) => (step.kind === "multi" ? step.options.length : total), 0);
/** Ten interests plus the notification question. The radar shows one blip for each. */
const SIGNAL_TOTAL = INTEREST_COUNT + 1;

type ProfileErrors = { displayName?: string; avatarUrl?: string };

export function OnboardingFlow() {
  const router = useRouter();
  const toast = useToast();
  const reduced = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const signal = useRef<SignalState>({ lit: 0, total: SIGNAL_TOTAL });
  const scene = useMemo(() => createSignalScene(signal), []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>();
  const loadView = useScreenError(loadError);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [answers, setAnswers] = useState<Answers>({});
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileDraft>({ displayName: "", avatarUrl: "" });
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({});
  const [busy, setBusy] = useState(false);

  const step = onboardingSteps[index] ?? onboardingSteps[0];
  const last = onboardingSteps.length - 1;
  const progress = progressFor(index, onboardingSteps.length);

  // Load the saved answers and the name on the account. Both come from the API, never from the URL.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [state, me] = await Promise.all([getOnboarding(), getProfile()]);
        if (!alive) return;
        setAnswers(sanitizeAnswers(state.answers));
        setCompletedAt(state.completedAt);
        setProfile({ displayName: me.displayName ?? "", avatarUrl: me.avatarUrl ?? "" });
      } catch (cause) {
        if (alive) setLoadError(cause);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The radar reacts to every answer as it's given.
  useEffect(() => {
    signal.current = {
      lit: Math.min(SIGNAL_TOTAL, answeredCount(answers)),
      total: SIGNAL_TOTAL,
    };
    scene.dirty = true;
  }, [answers, scene]);

  // Moving to a new step moves focus to its heading, so keyboard and screen reader users hear the change.
  // The first render doesn't move focus, so the page opens at the top.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [index]);

  function go(next: number, dir: 1 | -1) {
    setDirection(dir);
    setIndex(Math.min(last, Math.max(0, next)));
  }

  async function saveAnswers(completed: boolean) {
    const saved = await saveOnboarding(answers, completed);
    setAnswers(sanitizeAnswers(saved.answers));
    setCompletedAt(saved.completedAt);
  }

  async function next() {
    if (busy) return;

    if (step.kind === "profile") {
      const errors = checkProfile(profile);
      setProfileErrors(errors);
      if (Object.keys(errors).length > 0) return;
      setBusy(true);
      try {
        const saved = await updateProfile({
          displayName: profile.displayName.trim(),
          avatarUrl: profile.avatarUrl.trim() || null,
        });
        setProfile({ displayName: saved.displayName, avatarUrl: saved.avatarUrl ?? "" });
      } catch (cause) {
        showFormError(cause, PROFILE_FIELDS, toast, (field, message) => {
          setProfileErrors((current) => ({ ...current, [field]: message }));
        });
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    if (step.kind === "done") {
      await finish();
      return;
    }

    if (step.kind === "multi" || step.kind === "single") {
      // Saved at each question, so a refresh or a closed tab doesn't lose the answers.
      setBusy(true);
      try {
        await saveAnswers(false);
      } catch (cause) {
        toast.error(toastFor(cause));
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    go(index + 1, 1);
  }

  /** Marks the flow complete and leaves. Used by the last step and by "Skip for now". */
  async function finish() {
    setBusy(true);
    try {
      await saveAnswers(true);
      router.replace("/app");
      router.refresh();
    } catch (cause) {
      toast.error(toastFor(cause));
      setBusy(false);
    }
  }

  function chooseInterest(value: string, max: number) {
    setAnswers((current) => ({ ...current, interests: toggleInterest(current.interests, value, max) }));
  }

  function chooseNotifications(value: Notifications) {
    setAnswers((current) => ({ ...current, notifications: value }));
  }

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-5xl px-5 py-16 md:px-8">
        <p role="status" className="font-mono text-xs tracking-[0.12em] uppercase">
          Loading your setup…
        </p>
      </main>
    );
  }

  // The setup couldn't load at all: the error page takes the whole screen.
  if (loadView?.kind === "page") {
    return (
      <ErrorPage
        code={loadView.page}
        requestId={loadView.requestId}
        retryAfterSeconds={loadView.retryAfterSeconds}
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (loadView) {
    return (
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-5 py-16 md:px-8">
        <p role="alert" className="font-sans text-lg">
          {loadView.message}
        </p>
        <div>
          <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const animate = !reduced;
  const slide = direction * 24;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10 md:px-8 md:py-14">
      <header className="grid gap-8 md:grid-cols-[1fr_minmax(0,16rem)] md:items-end">
        <div className="grid gap-3">
          <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-muted">SETUP</p>
          <h1 className="font-sans text-4xl font-semibold tracking-tight md:text-5xl">Set up your account</h1>
          {completedAt ? (
            <p className="font-sans text-sm text-ink-soft">You've finished setup before. Changing your answers here is fine.</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <div className="flex justify-between font-mono text-[11px] tracking-[0.12em] uppercase">
            <span>
              Step {index + 1} of {onboardingSteps.length}
            </span>
            <span aria-hidden="true">{Math.round(progress * 100)}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuetext={`Step ${index + 1} of ${onboardingSteps.length}`}
            className="relative h-1 overflow-hidden bg-rule"
          >
            <motion.span
              aria-hidden="true"
              className="absolute inset-0 origin-left bg-vermilion"
              initial={false}
              animate={{ scaleX: progress }}
              transition={motionTransition(reduced === true, { duration: durationSeconds.slow, ease: easing.enter })}
            />
          </div>
        </div>
      </header>

      <ol aria-label="Steps" className="mt-8 grid grid-cols-5 gap-2 font-mono text-[11px] tracking-[0.1em]">
        {onboardingSteps.map((item, position) => (
          <li
            key={item.id}
            aria-current={position === index ? "step" : undefined}
            aria-label={`${position + 1}. ${item.title}`}
            className={cn(
              "border-t-2 pt-2 transition-colors duration-(--duration-fast)",
              position <= index ? "border-ink" : "border-rule",
              position === index ? "text-vermilion-deep" : "text-ink-muted",
            )}
          >
            {item.eyebrow.slice(0, 2)}
          </li>
        ))}
      </ol>

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void next();
        }}
        className="mt-12 grid gap-10 border-t border-ink pt-10 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]"
      >
        <div className="min-h-[300px] min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.section
              key={step.id}
              aria-labelledby="onboarding-step-title"
              initial={animate ? { opacity: 0, x: slide } : false}
              animate={{ opacity: 1, x: 0 }}
              exit={animate ? { opacity: 0, x: -slide } : { opacity: 0 }}
              transition={motionTransition(reduced === true, { duration: durationSeconds.slow, ease: easing.enter })}
              className="grid gap-6"
            >
              <StepHeader step={step} headingRef={headingRef} />
              <StepBody
                step={step}
                answers={answers}
                profile={profile}
                profileErrors={profileErrors}
                onProfile={(next) => {
                  setProfile(next);
                  setProfileErrors({});
                }}
                onInterest={chooseInterest}
                onNotifications={chooseNotifications}
                displayName={profile.displayName}
              />
            </motion.section>
          </AnimatePresence>
        </div>

        <div aria-hidden="true" className="relative min-h-[240px] border border-ink">
          <AsciiCanvas scene={scene} cell={14} className="absolute inset-0" />
        </div>
      </form>

      <footer className="mt-10 grid gap-4 border-t border-rule pt-6 sm:flex sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => go(index - 1, -1)} disabled={index === 0 || busy}>
            Back
          </Button>
          {step.kind !== "done" ? (
            <Button type="button" variant="ghost" onClick={() => void finish()} disabled={busy}>
              Skip for now
            </Button>
          ) : null}
        </div>
        <p role="status" aria-live="polite" className="font-mono text-[11px] tracking-[0.08em]">
          {busy ? "Saving…" : ""}
        </p>
        <Button type="submit" form={FORM_ID} loading={busy} className="w-full sm:w-auto">
          {step.kind === "done" ? "Finish setup" : "Next"}
        </Button>
      </footer>
    </main>
  );
}

function StepHeader({ step, headingRef }: { step: OnboardingStep; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  return (
    <div className="grid gap-3">
      <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-muted">{step.eyebrow}</p>
      <h2 id="onboarding-step-title" ref={headingRef} tabIndex={-1} className="font-sans text-3xl font-semibold tracking-tight outline-none md:text-4xl">
        {step.title}
      </h2>
      <p className="max-w-prose font-sans text-base text-ink-soft">{step.body}</p>
    </div>
  );
}

type StepBodyProps = {
  step: OnboardingStep;
  answers: Answers;
  profile: ProfileDraft;
  profileErrors: ProfileErrors;
  onProfile: (next: ProfileDraft) => void;
  onInterest: (value: string, max: number) => void;
  onNotifications: (value: Notifications) => void;
  displayName: string;
};

function StepBody({ step, answers, profile, profileErrors, onProfile, onInterest, onNotifications, displayName }: StepBodyProps) {
  if (step.kind === "profile") {
    const initial = displayName.trim().charAt(0).toUpperCase() || "?";
    return (
      <div className="grid gap-6">
        <div className="flex items-end gap-5">
          <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center bg-ink font-sans text-2xl font-semibold text-paper">
            {initial}
          </span>
          <p className="font-sans text-sm text-ink-soft">This is how you'll appear to others.</p>
        </div>
        <Field
          label="Name"
          name="displayName"
          autoComplete="name"
          maxLength={120}
          value={profile.displayName}
          error={profileErrors.displayName}
          onChange={(event) => onProfile({ ...profile, displayName: event.target.value })}
        />
        <Field
          label="Picture link (optional)"
          name="avatarUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          maxLength={2048}
          value={profile.avatarUrl}
          error={profileErrors.avatarUrl}
          onChange={(event) => onProfile({ ...profile, avatarUrl: event.target.value })}
        />
      </div>
    );
  }

  if (step.kind === "multi") {
    const chosen = answers.interests ?? [];
    const full = chosen.length >= step.max;
    return (
      <div className="grid gap-4">
        <p aria-live="polite" className="font-mono text-[11px] tracking-[0.12em] uppercase text-ink-muted">
          {chosen.length} of {step.max} chosen
        </p>
        <div role="group" aria-label={step.title} className="flex flex-wrap gap-2">
          {step.options.map((option) => {
            const on = chosen.includes(option.value);
            return (
              <Button
                key={option.value}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={on}
                disabled={!on && full}
                onClick={() => onInterest(option.value, step.max)}
                className={cn(
                  "h-11 border border-ink hover:no-underline",
                  on ? "bg-ink text-paper hover:bg-ink" : "hover:bg-paper-sunk",
                )}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      </div>
    );
  }

  if (step.kind === "single") {
    return (
      <fieldset className="grid gap-3">
        <legend className="sr-only">{step.title}</legend>
        {step.options.map((option) => {
          const on = answers.notifications === option.value;
          return (
            <label key={option.value} className="relative cursor-pointer">
              <input
                type="radio"
                name={step.key}
                value={option.value}
                checked={on}
                onChange={() => onNotifications(option.value as Notifications)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "grid gap-1 border border-ink px-5 py-4 transition-colors duration-(--duration-base) peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-vermilion",
                  on ? "bg-ink text-paper" : "hover:bg-paper-sunk",
                )}
              >
                <span className="font-sans text-base font-medium">{option.label}</span>
                {option.hint ? <span className="font-mono text-[11px] tracking-[0.04em] opacity-80">{option.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </fieldset>
    );
  }

  if (step.kind === "done") {
    const interests = (answers.interests ?? []).map((value) => INTEREST_LABELS.get(value) ?? value);
    const notificationLabel = answers.notifications ? NOTIFICATION_LABELS.get(answers.notifications) : undefined;
    return (
      <dl className="grid gap-4 font-sans">
        <SummaryRow label="Name" value={displayName || "Not set"} />
        <SummaryRow label="Interests" value={interests.length ? interests.join(", ") : "None chosen"} />
        <SummaryRow label="Notifications" value={notificationLabel ?? "Not set"} />
      </dl>
    );
  }

  return null;
}

const NOTIFICATION_LABELS = new Map(
  onboardingSteps.flatMap((step) => (step.kind === "single" ? step.options.map((option) => [option.value, option.label] as const) : [])),
);

const INTEREST_LABELS = new Map(
  onboardingSteps.flatMap((step) => (step.kind === "multi" ? step.options.map((option) => [option.value, option.label] as const) : [])),
);

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-rule pb-3">
      <dt className="font-mono text-[11px] tracking-[0.12em] uppercase text-ink-muted">{label}</dt>
      <dd className="text-base">{value}</dd>
    </div>
  );
}
