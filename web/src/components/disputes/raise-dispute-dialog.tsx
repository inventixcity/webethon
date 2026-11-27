"use client";

import { useId, useState, type FormEvent } from "react";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { messageFor } from "@/lib/errors";
import type { Dispute } from "@/lib/exam/types";
import { DISPUTE_MAX_LENGTH, DISPUTE_MIN_LENGTH } from "./format";

export type DisputeTarget = { itemId: string; position: number };

/**
 * Asks a candidate why a mark is wrong. Mounted only while a question is being disputed, so each open starts with an
 * empty reason. Radix keeps focus inside the dialog, Escape closes it, and focus returns to the button that opened it.
 */
export function RaiseDisputeDialog({
  attemptId,
  target,
  onClose,
  onRaised,
}: {
  attemptId: string;
  target: DisputeTarget;
  onClose: () => void;
  /** Called after the server accepts the dispute, so the caller can reload the list. */
  onRaised: () => void;
}) {
  const ids = useId();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = `${ids}-form`;
  const fieldId = `${ids}-reason`;
  const hintId = `${ids}-hint`;
  const countId = `${ids}-count`;
  const errorId = `${ids}-error`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const text = reason.trim();
    if (text.length < DISPUTE_MIN_LENGTH) {
      setError(`Write at least ${DISPUTE_MIN_LENGTH} characters explaining the mark.`);
      return;
    }
    if (text.length > DISPUTE_MAX_LENGTH) {
      setError(`Keep it to ${DISPUTE_MAX_LENGTH} characters or fewer.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<Dispute | undefined>(`/attempts/${encodeURIComponent(attemptId)}/disputes`, {
        body: { itemId: target.itemId, reason: text },
      });
      toast.success("Dispute raised. Your examiner will review it.");
      onRaised();
      onClose();
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      dismissible={!busy}
      eyebrow={`Dispute / Question ${target.position}`}
      title="Dispute this mark"
      description={`One dispute per question, within 7 days of your results. This is for question ${target.position}.`}
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Raise dispute
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="grid gap-6">
        <div className="grid gap-2 border-l-2 border-ink bg-paper-raised p-4">
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">What happens next</p>
          <p className="text-sm text-ink-soft">
            Your examiner reviews it; any change is recorded and your certificate is re-issued with the same code.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={fieldId}>Why is this mark wrong?</Label>
          <Textarea
            id={fieldId}
            name="reason"
            rows={6}
            maxLength={DISPUTE_MAX_LENGTH}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={[hintId, countId, error ? errorId : null].filter(Boolean).join(" ")}
            className="min-h-40"
          />
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p id={hintId} className="text-sm text-ink-soft">
              Between {DISPUTE_MIN_LENGTH} and {DISPUTE_MAX_LENGTH} characters. Say what the mark should be and why.
            </p>
            <p id={countId} className="font-mono text-[11px] tracking-[0.08em] text-ink-muted tabular-nums">
              {reason.length} / {DISPUTE_MAX_LENGTH} characters
            </p>
          </div>
          <FieldError id={errorId} message={error} />
        </div>
      </form>
    </Dialog>
  );
}
