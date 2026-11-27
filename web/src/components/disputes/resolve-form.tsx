"use client";

import { useId, useState, type FormEvent } from "react";
import { HoldButton } from "@/components/effects/hold-button";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { messageFor } from "@/lib/errors";
import type { DisputeResolution, DisputeStatus } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import type { ExaminerDispute } from "./examiner-types";
import { DISPUTE_MAX_LENGTH, formatMarks, isQuarterStep, MARKS_STEP, RESOLUTION_LABEL, scoreChangeText, scoreLine } from "./format";

type Decision = Exclude<DisputeStatus, "open">;

/** The request body for POST /disputes/{id}/resolve. */
type ResolveBody = {
  status: Decision;
  resolution: DisputeResolution;
  response: string;
  marks?: number;
  alternativeOptionIds?: string[];
};

type FieldKey = "decision" | "marks" | "alternatives" | "response";

const DECISION_HINT: Record<Decision, string> = {
  accepted: "The candidate's point is right. The resolution below applies.",
  rejected: "The mark stands and nothing else changes.",
};

/** The success toast line: the score change when there was one, as in "Score 12.5 → 14.0". */
function resolvedToast(before: number | null, after: number | null): string {
  const change = scoreChangeText(before, after);
  if (change) return `Dispute resolved. ${change}`;
  if (before !== null) return `Dispute resolved. Score ${formatMarks(before)} unchanged.`;
  return "Dispute resolved.";
}

function ChoiceRadio({
  id,
  name,
  value,
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint?: string;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 py-1",
        disabled ? "cursor-not-allowed text-ink-muted" : "cursor-pointer",
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-1 size-4 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <span className="font-medium">{label}</span>
      {hint ? <span className="col-start-2 text-sm text-ink-soft">{hint}</span> : null}
    </label>
  );
}

/**
 * The examiner's decision on one dispute. Accept or reject, then at most one resolution. Voiding a question is the only
 * action held to confirm; the others go through a confirm dialog. Every decision needs a message the candidate reads.
 */
export function ResolveForm({
  dispute,
  onResolved,
}: {
  dispute: ExaminerDispute;
  onResolved: (next: ExaminerDispute) => void;
}) {
  const ids = useId();
  const toast = useToast();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [resolution, setResolution] = useState<DisputeResolution>("none");
  const [marks, setMarks] = useState("");
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [response, setResponse] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ResolveBody | null>(null);
  // Changing the key resets the hold button, so a failed void can be held again.
  const [holdKey, setHoldKey] = useState(0);

  const max = dispute.itemMarks;
  const options = dispute.options ?? [];
  const rejected = decision === "rejected";

  /** Checks the whole form. Returns the request body, or null after showing what is wrong. */
  function check(): ResolveBody | null {
    const next: Partial<Record<FieldKey, string>> = {};
    if (!decision) next.decision = "Choose whether to accept or reject this dispute.";

    if (resolution === "regrade") {
      const value = Number(marks);
      if (marks.trim() === "" || !Number.isFinite(value)) {
        next.marks = "Enter the new marks for this answer.";
      } else if (value < 0 || (max !== undefined && value > max)) {
        next.marks = max !== undefined ? `Marks must be between 0 and ${formatMarks(max)}.` : "Marks cannot be negative.";
      } else if (!isQuarterStep(value)) {
        next.marks = `Use steps of ${MARKS_STEP} marks.`;
      }
    }
    if (resolution === "accept_alternative" && alternatives.length === 0) {
      next.alternatives = "Choose at least one option to accept.";
    }
    const text = response.trim();
    if (text.length === 0) next.response = "Write a message for the candidate. They will read it.";
    else if (text.length > DISPUTE_MAX_LENGTH) next.response = `Keep the message to ${DISPUTE_MAX_LENGTH} characters or fewer.`;

    setErrors(next);
    if (Object.keys(next).length > 0 || !decision) return null;

    return {
      status: decision,
      resolution,
      response: text,
      ...(resolution === "regrade" ? { marks: Number(marks) } : {}),
      ...(resolution === "accept_alternative" ? { alternativeOptionIds: alternatives } : {}),
    };
  }

  async function send(body: ResolveBody) {
    setBusy(true);
    try {
      const saved = await api<ExaminerDispute | undefined>(`/disputes/${encodeURIComponent(dispute.id)}/resolve`, { body });
      const next: ExaminerDispute = {
        ...dispute,
        ...(saved ?? {}),
        status: body.status,
        resolution: body.resolution,
        response: body.response,
        resolvedAt: saved?.resolvedAt ?? new Date().toISOString(),
      };
      toast.success(resolvedToast(next.scoreBefore, next.scoreAfter));
      onResolved(next);
    } catch (cause) {
      toast.error(messageFor(cause));
      setHoldKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Voiding is confirmed by holding the button, so Enter in a field never submits a void.
    if (resolution === "void_item" || busy) return;
    const body = check();
    if (body) setPending(body);
  }

  function voidQuestion() {
    const body = check();
    if (body) void send(body);
    else setHoldKey((value) => value + 1);
  }

  const summary = pending
    ? [
        `Decision: ${pending.status === "accepted" ? "accept" : "reject"}.`,
        `Resolution: ${RESOLUTION_LABEL[pending.resolution]}${pending.marks !== undefined ? `, ${formatMarks(pending.marks)} marks` : ""}.`,
        pending.status === "accepted" && pending.resolution !== "none"
          ? "Any change is recorded and the certificate is re-issued with the same code."
          : "The candidate sees your message.",
      ].join(" ")
    : "";

  return (
    <>
      <form noValidate onSubmit={review} className="grid gap-7 border-t border-rule pt-6" aria-label={`Resolve dispute, question ${dispute.position}`}>
        <fieldset className="grid gap-2" aria-describedby={errors.decision ? `${ids}-decision-error` : undefined}>
          <legend className="mb-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Decision</legend>
          <ChoiceRadio
            id={`${ids}-accept`}
            name={`${ids}-decision`}
            value="accepted"
            label="Accept the dispute"
            hint={DECISION_HINT.accepted}
            checked={decision === "accepted"}
            onChange={() => {
              setDecision("accepted");
              setErrors((e) => ({ ...e, decision: undefined }));
            }}
          />
          <ChoiceRadio
            id={`${ids}-reject`}
            name={`${ids}-decision`}
            value="rejected"
            label="Reject the dispute"
            hint={DECISION_HINT.rejected}
            checked={decision === "rejected"}
            onChange={() => {
              setDecision("rejected");
              setResolution("none");
              setErrors((e) => ({ ...e, decision: undefined }));
            }}
          />
          <FieldError id={`${ids}-decision-error`} message={errors.decision} />
        </fieldset>

        <fieldset className="grid gap-2" disabled={rejected}>
          <legend className="mb-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Resolution</legend>
          {rejected ? <p className="text-sm text-ink-soft">A rejected dispute leaves the marks as they are.</p> : null}
          {(["none", "regrade", "void_item", "accept_alternative"] as const).map((value) => {
            const needsOptions = value === "accept_alternative" && options.length === 0;
            return (
              <ChoiceRadio
                key={value}
                id={`${ids}-res-${value}`}
                name={`${ids}-resolution`}
                value={value}
                label={RESOLUTION_LABEL[value]}
                hint={
                  value === "none"
                    ? "Keep the marks. Only the message is sent."
                    : value === "regrade"
                      ? "Set a new mark for this answer."
                      : value === "void_item"
                        ? "Removes the question from every candidate's score."
                        : needsOptions
                          ? "Not available: the options for this question are not loaded yet."
                          : "Mark one or more options as correct for everyone."
                }
                disabled={needsOptions}
                checked={resolution === value}
                onChange={() => {
                  setResolution(value);
                  setErrors((e) => ({ ...e, marks: undefined, alternatives: undefined }));
                }}
              />
            );
          })}

          {resolution === "regrade" ? (
            <div className="mt-3 grid gap-2 border-l-2 border-rule pl-4">
              <Label htmlFor={`${ids}-marks`}>
                New marks{max !== undefined ? ` (0 to ${formatMarks(max)})` : ""}, steps of {MARKS_STEP}
              </Label>
              <Input
                id={`${ids}-marks`}
                variant="box"
                type="number"
                inputMode="decimal"
                min={0}
                max={max}
                step={MARKS_STEP}
                value={marks}
                onChange={(event) => {
                  setMarks(event.target.value);
                  setErrors((e) => ({ ...e, marks: undefined }));
                }}
                aria-invalid={errors.marks ? true : undefined}
                aria-describedby={errors.marks ? `${ids}-marks-error` : undefined}
                className="w-40 font-mono tabular-nums"
              />
              <FieldError id={`${ids}-marks-error`} message={errors.marks} />
            </div>
          ) : null}

          {resolution === "void_item" ? (
            <div className="mt-3 grid gap-3 border-2 border-vermilion-deep p-4">
              <p className="font-mono text-[11px] tracking-[0.12em] text-vermilion-deep uppercase">Strong warning</p>
              <p className="text-sm text-ink">
                This removes the question from every candidate&apos;s score and re-issues certificates.
              </p>
              <p className="text-sm text-ink-soft">Press and hold the button below for about a second to confirm.</p>
            </div>
          ) : null}

          {resolution === "accept_alternative" && options.length > 0 ? (
            <div role="group" aria-labelledby={`${ids}-alt-label`} className="mt-3 grid gap-3 border-l-2 border-rule pl-4">
              <p id={`${ids}-alt-label`} className="text-sm font-medium">
                Options to accept as correct
              </p>
              {options.map((option) => {
                const id = `${ids}-opt-${option.id}`;
                const checked = alternatives.includes(option.id);
                return (
                  <div key={option.id} className="flex items-start gap-3">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(next) => {
                        setAlternatives((list) => (next === true ? [...list, option.id] : list.filter((item) => item !== option.id)));
                        setErrors((e) => ({ ...e, alternatives: undefined }));
                      }}
                      className="mt-0.5"
                    />
                    <Label htmlFor={id} className="cursor-pointer text-sm normal-case tracking-normal">
                      {option.text}
                    </Label>
                  </div>
                );
              })}
              <FieldError id={`${ids}-alt-error`} message={errors.alternatives} />
            </div>
          ) : null}
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor={`${ids}-response`}>Message to the candidate (required)</Label>
          <Textarea
            id={`${ids}-response`}
            rows={4}
            maxLength={DISPUTE_MAX_LENGTH}
            value={response}
            onChange={(event) => {
              setResponse(event.target.value);
              setErrors((e) => ({ ...e, response: undefined }));
            }}
            aria-invalid={errors.response ? true : undefined}
            aria-describedby={`${ids}-response-count${errors.response ? ` ${ids}-response-error` : ""}`}
          />
          <p id={`${ids}-response-count`} className="font-mono text-[11px] text-ink-muted tabular-nums">
            {response.length} / {DISPUTE_MAX_LENGTH}. The candidate sees this message.
          </p>
          <FieldError id={`${ids}-response-error`} message={errors.response} />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {resolution === "void_item" ? (
            <HoldButton
              key={holdKey}
              label="Hold to void question"
              doneLabel="Question voided"
              onConfirm={voidQuestion}
            />
          ) : (
            <Button type="submit" loading={busy}>
              Review and submit
            </Button>
          )}
          <p className="text-sm text-ink-muted">Current score: {scoreLine(dispute)}</p>
        </div>
      </form>

      <ConfirmDialog
        open={pending !== null}
        title="Submit this decision?"
        eyebrow="Confirm / Dispute"
        confirmLabel="Submit decision"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          const body = pending;
          setPending(null);
          void send(body);
        }}
      >
        <p>{summary}</p>
      </ConfirmDialog>
    </>
  );
}
