"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import type { IntegrityReport, Outage } from "@/lib/exam/types";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, formatSeconds, messageOf } from "@/components/analytics/format";
import { describeError } from "@/lib/errors/describe";
import { ConfirmDialog } from "./confirm-dialog";
import { PriorityChip } from "./priority-chip";
import { BrailleSpinner } from "@/components/loaders/text-loaders";

export const INDICATOR_NOTICE = "Indicators support human review. They are not evidence of misconduct.";
const TIMELINE_LIMIT = 200;

type CreditDraft = { outage: Outage; seconds: number; reason: string };

/**
 * Side panel for one candidate's attempt: indicators, event timeline, verified outages and the audited
 * time-credit action. Every control here is a review aid. Nothing here changes an answer or a score.
 */
export function IncidentPanel({
  attemptId,
  title,
  onClose,
  onChanged,
}: {
  attemptId: string;
  title: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [outages, setOutages] = useState<Outage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [creditOutage, setCreditOutage] = useState<Outage | null>(null);
  const [draft, setDraft] = useState<CreditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const draftRef = useRef<CreditDraft | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape closes the panel, unless the confirmation on top of it is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && draftRef.current === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      api<IntegrityReport>(`/attempts/${attemptId}/integrity`),
      api<Outage[]>(`/attempts/${attemptId}/outages`),
    ])
      .then(([nextReport, nextOutages]) => {
        if (!live) return;
        setReport(nextReport);
        setOutages(nextOutages);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [attemptId, version]);

  async function grantCredit() {
    if (!draft) return;
    setBusy(true);
    try {
      await api<{ deadlineAt: string }>(`/attempts/${attemptId}/time-credit`, {
        body: {
          seconds: draft.seconds,
          reason: draft.reason.trim(),
          outageFrom: draft.outage.from,
          outageTo: draft.outage.to,
        },
      });
      toast.success(`Granted ${formatSeconds(draft.seconds)} of time credit. The audit log has recorded it.`);
      setDraft(null);
      setCreditOutage(null);
      setVersion((value) => value + 1);
      onChanged();
    } catch (cause) {
      toast.error(describeError(cause, { context: "action" }));
      setDraft(null);
    } finally {
      setBusy(false);
    }
  }

  const events = report?.events ?? [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/60" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="grid h-full w-full max-w-2xl content-start gap-8 overflow-y-auto border-l border-ink bg-paper p-5 text-ink md:p-8"
      >
        <header className="grid gap-3 border-b border-ink pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Candidate attempt</p>
              <h2 id={titleId} ref={headingRef} tabIndex={-1} className="mt-2 text-3xl leading-none font-semibold tracking-tight break-words outline-none">
                {title}
              </h2>
            </div>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
          <p className="font-mono text-[11px] text-ink-soft">{INDICATOR_NOTICE}</p>
          {report && <PriorityChip priority={report.reviewPriority} className="w-fit" />}
        </header>

        {loading && <BrailleSpinner label="Loading review data" className="text-xs text-ink-muted" />}
        {error && (
          <div className="grid gap-3 border border-vermilion-deep p-4">
            <p className="text-sm text-vermilion-deep">{error}</p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {report && (
          <>
            <section aria-labelledby={`${titleId}-indicators`} className="grid gap-4">
              <h3 id={`${titleId}-indicators`} className="font-mono text-[11px] tracking-[0.12em] uppercase">
                Indicators for review
              </h3>
              {report.indicators.length === 0 ? (
                <p className="border border-rule p-4 text-sm text-ink-muted">No indicators were recorded for this attempt.</p>
              ) : (
                <ul className="divide-y divide-rule border-y border-rule">
                  {report.indicators.map((indicator) => (
                    <li key={indicator.key} className="grid gap-1 py-3">
                      <p className="font-medium">
                        {indicator.label}
                        <span className="ml-2 font-mono text-[11px] text-ink-muted">×{indicator.count}</span>
                      </p>
                      <p className="text-sm text-ink-soft">{indicator.explanation}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby={`${titleId}-outages`} className="grid gap-4">
              <h3 id={`${titleId}-outages`} className="font-mono text-[11px] tracking-[0.12em] uppercase">
                Verified connection outages
              </h3>
              <p className="text-sm text-ink-soft">
                Gaps of 45 seconds or more in heartbeats from the candidate&apos;s device. A time credit can only cover an
                outage that was verified this way.
              </p>
              {outages.length === 0 ? (
                <p className="border border-rule p-4 text-sm text-ink-muted">No verified outages.</p>
              ) : (
                <ul className="grid gap-3">
                  {outages.map((outage) => (
                    <li key={`${outage.from}-${outage.to}`} className="grid gap-3 border border-rule p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-mono text-xs">
                          {formatDateTime(outage.from)} to {formatDateTime(outage.to)}
                        </p>
                        <p className="font-mono text-xs text-ink-soft">
                          {formatSeconds(outage.seconds)} · {outage.credited ? "Credited" : "Not credited"}
                        </p>
                      </div>
                      {!outage.credited && creditOutage !== outage && (
                        <div>
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Grant time credit for the outage from ${formatDateTime(outage.from)}`}
                            onClick={() => setCreditOutage(outage)}
                          >
                            Grant time credit
                          </Button>
                        </div>
                      )}
                      {creditOutage === outage && (
                        <CreditForm
                          outage={outage}
                          onCancel={() => setCreditOutage(null)}
                          onReview={(seconds, reason) => setDraft({ outage, seconds, reason })}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby={`${titleId}-timeline`} className="grid gap-4">
              <h3 id={`${titleId}-timeline`} className="font-mono text-[11px] tracking-[0.12em] uppercase">
                Event timeline
              </h3>
              {events.length === 0 ? (
                <p className="border border-rule p-4 text-sm text-ink-muted">No events recorded.</p>
              ) : (
                <>
                  <ol className="divide-y divide-rule border-y border-rule">
                    {events.slice(0, TIMELINE_LIMIT).map((event) => (
                      <li key={event.id} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-3 text-sm">
                        <time dateTime={event.recordedAt} className="font-mono text-[11px] text-ink-muted">
                          {formatDateTime(event.recordedAt)}
                        </time>
                        <p className="font-mono text-xs tracking-[0.04em]">
                          {event.kind}
                          <span className="ml-2 text-ink-muted uppercase">{event.severity}</span>
                        </p>
                        {event.durationMs !== null && (
                          <p className="col-start-2 font-mono text-[11px] text-ink-soft">
                            Lasted {formatSeconds(event.durationMs / 1000)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                  {events.length > TIMELINE_LIMIT && (
                    <p className="font-mono text-[11px] text-ink-muted">
                      Showing the newest {TIMELINE_LIMIT} of {events.length} events.
                    </p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </section>

      <ConfirmDialog
        open={draft !== null}
        title="Grant time credit"
        confirmLabel="Grant credit"
        tone="danger"
        busy={busy}
        onConfirm={() => void grantCredit()}
        onCancel={() => setDraft(null)}
      >
        {draft && (
          <>
            <p>
              This adds <strong>{formatSeconds(draft.seconds)}</strong> to the deadline of {title}&apos;s attempt.
            </p>
            <p>
              The change is written to the audit log with your account, the reason you entered and the verified outage
              it covers ({formatDateTime(draft.outage.from)} to {formatDateTime(draft.outage.to)}). The server limits
              credit to the verified outage length. The record cannot be removed from this screen.
            </p>
            <p className="font-mono text-xs text-ink-muted">Reason: {draft.reason.trim()}</p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

function CreditForm({
  outage,
  onCancel,
  onReview,
}: {
  outage: Outage;
  onCancel: () => void;
  onReview: (seconds: number, reason: string) => void;
}) {
  const [seconds, setSeconds] = useState(String(Math.round(outage.seconds)));
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const ids = useId();
  const maxSeconds = Math.round(outage.seconds);

  const secondsValue = Number(seconds);
  const secondsError =
    !Number.isInteger(secondsValue) || seconds.trim() === ""
      ? "Enter a whole number of seconds."
      : secondsValue < 1
        ? "Enter at least 1 second."
        : secondsValue > maxSeconds
          ? `Cannot exceed the verified outage (${formatSeconds(maxSeconds)}).`
          : null;
  const reasonTrimmed = reason.trim();
  const reasonError =
    reasonTrimmed.length < 3 ? "Give a reason of at least 3 characters." : reason.length > 500 ? "Keep the reason to 500 characters." : null;

  function review(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (secondsError || reasonError) return;
    onReview(secondsValue, reasonTrimmed);
  }

  return (
    <form onSubmit={review} noValidate className="grid gap-4 border border-ink p-4">
      <div className="grid gap-1">
        <Label htmlFor={`${ids}-seconds`}>Seconds to credit</Label>
        <Input
          id={`${ids}-seconds`}
          inputMode="numeric"
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
          aria-invalid={submitted && secondsError ? true : undefined}
          aria-describedby={`${ids}-seconds-error`}
        />
        <FieldError id={`${ids}-seconds-error`} message={submitted ? secondsError : null} />
        <p className="font-mono text-[11px] text-ink-muted">Prefilled with the outage length, {formatSeconds(maxSeconds)}.</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${ids}-reason`}>Reason (required)</Label>
        <textarea
          id={`${ids}-reason`}
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={submitted && reasonError ? true : undefined}
          aria-describedby={`${ids}-reason-error`}
          className="w-full resize-y border border-rule bg-paper-raised p-3 font-sans text-sm text-ink"
        />
        <FieldError id={`${ids}-reason-error`} message={submitted ? reasonError : null} />
      </div>
      <p className="text-xs text-ink-muted">
        Granting credit is audited. It records your account, the reason and the outage. Review it before you confirm.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="sm">
          Review credit
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
