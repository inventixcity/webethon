"use client";

import { useId, useState } from "react";
import { api } from "@/lib/api/client";
import type { BulkCreditResult } from "@/lib/exam/types";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { messageOf } from "@/components/analytics/format";

const WINDOW_DEFAULT_MS = 15 * 60 * 1000;
const WINDOW_MAX_MS = 2 * 60 * 60 * 1000;
const REASON_MIN = 3;
const REASON_MAX = 500;
const FUTURE_SLACK_MS = 60 * 1000;

export const CREDIT_EXPLANATION =
  "Only candidates whose devices were verifiably offline in this window get time back, exactly the length of their verified outage. Every credit is audited.";

/** Plain-language total for a credit, for example "45 s", "4 min" or "4 min 20 s". */
export function formatCredit(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A datetime-local value (local wall-clock time, minute precision) for a moment. */
function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Credits verified outages across the whole exam. Mounted only while open, so every opening starts from the
 * default window. Two steps: review the window and reason, then confirm. Focus starts in the first field and
 * returns to the opener when the dialog closes.
 */
export function OutageCreditDialog({
  examId,
  serverNow,
  onCredited,
  onOpenChange,
}: {
  examId: string;
  /** Server time (ms), so the default window matches the server clock rather than this device's. */
  serverNow: number;
  onCredited: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const toast = useToast();
  const [from, setFrom] = useState(() => toLocalInput(Math.floor((serverNow - WINDOW_DEFAULT_MS) / 60000) * 60000));
  const [to, setTo] = useState(() => toLocalInput(Math.floor(serverNow / 60000) * 60000));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);

  /** Checks the window and reason. Returns the window in ms, or null after setting the error. */
  function validate(): { from: number; to: number } | null {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs)) return fail("Enter when the outage window starts.");
    if (Number.isNaN(toMs)) return fail("Enter when the outage window ends.");
    if (toMs <= fromMs) return fail("The window must end after it starts.");
    if (toMs - fromMs > WINDOW_MAX_MS) return fail("A window can be at most 2 hours.");
    if (toMs > serverNow + FUTURE_SLACK_MS) return fail("The window can't end in the future.");
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) return fail(`Give a reason of at least ${REASON_MIN} characters.`);
    if (trimmed.length > REASON_MAX) return fail(`The reason is limited to ${REASON_MAX} characters.`);
    setError(null);
    return { from: fromMs, to: toMs };
  }

  function fail(message: string): null {
    setError(message);
    return null;
  }

  function review() {
    if (validate()) setStep("confirm");
  }

  async function confirm() {
    const range = validate();
    if (!range || busy) return;
    setBusy(true);
    try {
      const result = await api<BulkCreditResult>(`/exams/${examId}/outage-credit`, {
        method: "POST",
        body: {
          from: new Date(range.from).toISOString(),
          to: new Date(range.to).toISOString(),
          reason: reason.trim(),
        },
      });
      toast.success(
        `Credited ${plural(result.credited, "candidate")} · ${formatCredit(result.secondsTotal)} total · ${result.skipped} skipped`,
      );
      onCredited();
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = "w-full";
  const errorId = `${ids}-error`;
  const invalid = error ? true : undefined;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      dismissible={!busy}
      eyebrow="Monitor / audited"
      title="Credit an outage"
      description={CREDIT_EXPLANATION}
      footer={
        step === "edit" ? (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={review}>Review credit</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setStep("edit")}>
              Back
            </Button>
            <Button loading={busy} onClick={() => void confirm()}>
              Credit outage
            </Button>
          </>
        )
      }
    >
      {step === "edit" ? (
        <div className="grid gap-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-from`}>From</Label>
              <Input
                id={`${ids}-from`}
                variant="box"
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={error ? errorId : undefined}
                className={fieldClass}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-to`}>To</Label>
              <Input
                id={`${ids}-to`}
                variant="box"
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={error ? errorId : undefined}
                className={fieldClass}
              />
            </div>
          </div>
          <p className="font-mono text-[11px] text-ink-muted">Default: the last 15 minutes. A window can be at most 2 hours.</p>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-reason`}>Reason (required)</Label>
            <Textarea
              id={`${ids}-reason`}
              rows={3}
              required
              aria-required="true"
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={invalid}
              aria-describedby={error ? errorId : `${ids}-count`}
              placeholder="For example: exam platform outage in the east building"
            />
            <p id={`${ids}-count`} className="font-mono text-[11px] text-ink-muted tabular-nums">
              {reason.length} / {REASON_MAX}. Stored in the audit log with the credit.
            </p>
          </div>
          <FieldError id={errorId} message={error} />
        </div>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-3 border-l-2 border-ink p-4">
            <p className="text-base text-ink">
              Credit verified outages between <span className="font-mono tabular-nums">{clock(Date.parse(from))}</span> and{" "}
              <span className="font-mono tabular-nums">{clock(Date.parse(to))}</span>?
            </p>
            <p className="text-sm text-ink-soft">
              Candidates with no verified outage in this window are skipped. Each credit is written to the audit log.
            </p>
            <p className="text-sm text-ink-soft">
              <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Reason </span>
              {reason.trim()}
            </p>
          </div>
          <FieldError id={errorId} message={error} />
        </div>
      )}
    </Dialog>
  );
}
