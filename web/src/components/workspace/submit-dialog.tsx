"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Modal } from "./drawer";
import type { PaletteItem } from "./palette";
import { pad2 } from "./model";

type SubmitDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
  pendingCount: number;
  online: boolean;
  returnHref: string;
  returnLabel: string;
  onJump: (index: number) => void;
  onSubmit: () => Promise<void>;
  onSubmitted: () => void;
};

/** Review and submit. Submitting is final, so the summary shows unanswered and flagged questions first. */
export function SubmitDialog({
  open,
  onOpenChange,
  items,
  pendingCount,
  online,
  returnHref,
  returnLabel,
  onJump,
  onSubmit,
  onSubmitted,
}: SubmitDialogProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const answered = items.filter((item) => item.answered).length;
  const unanswered = items.filter((item) => !item.answered);
  const flagged = items.filter((item) => item.flagged);
  const syncing = pendingCount > 0 && online;
  const offlinePending = pendingCount > 0 && !online;

  async function submit() {
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit();
      setDone(true);
      onSubmitted();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function jump(index: number) {
    onOpenChange(false);
    onJump(index);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={done ? "Submitted" : "Review and submit"}
      description={done ? undefined : "Once submitted, you cannot change your answers."}
    >
      {done ? (
        <div className="grid gap-5 p-5">
          <p className="font-sans text-base">Your answers have been submitted. You can close this window.</p>
          <Button asChild variant="secondary">
            <Link href={returnHref}>{returnLabel}</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 p-5">
          <dl className="grid grid-cols-3 border border-ink font-mono text-[11px] tracking-[0.1em] uppercase">
            <Stat label="Answered" value={answered} />
            <Stat label="Unanswered" value={unanswered.length} className="border-x border-ink" />
            <Stat label="Flagged" value={flagged.length} />
          </dl>

          {unanswered.length > 0 && (
            <section aria-labelledby="ws-submit-unanswered">
              <h3 id="ws-submit-unanswered" className="font-mono text-[11px] tracking-[0.12em] uppercase">
                Unanswered
              </h3>
              <p className="mt-2 font-sans text-sm text-ink-soft">
                {unanswered.length === 1 ? "One question is" : `${unanswered.length} questions are`} unanswered. You
                can still submit, but unanswered questions score zero.
              </p>
              <JumpList items={unanswered} onJump={jump} />
            </section>
          )}

          {flagged.length > 0 && (
            <section aria-labelledby="ws-submit-flagged">
              <h3 id="ws-submit-flagged" className="font-mono text-[11px] tracking-[0.12em] uppercase">
                Flagged for review
              </h3>
              <JumpList items={flagged} onJump={jump} />
            </section>
          )}

          {syncing && (
            <p role="status" className="border border-(--ws-line) p-4 font-sans text-sm">
              Waiting for {pendingCount} {pendingCount === 1 ? "answer" : "answers"} to sync. Submit unlocks when
              syncing finishes.
            </p>
          )}

          {offlinePending && (
            <p role="status" className="border border-ink p-4 font-sans text-sm">
              You&apos;re offline. Submitting now stores your submission on this device, and it will be sent when you
              reconnect. {pendingCount} {pendingCount === 1 ? "answer is" : "answers are"} still waiting to sync.
            </p>
          )}

          {failed && (
            <p role="alert" className="border border-vermilion-deep p-4 font-sans text-sm text-vermilion-deep">
              The submission did not go through. Your answers are still saved. Try again.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Back to exam
            </Button>
            <Button type="button" onClick={submit} loading={busy} disabled={syncing}>
              Submit answers
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1 p-4", className)}>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-sans text-3xl font-semibold tracking-[-0.03em] tabular-nums">{value}</dd>
    </div>
  );
}

function JumpList({ items, onJump }: { items: PaletteItem[]; onJump: (index: number) => void }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => {
        const index = item.index;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onJump(index)}
              aria-label={`Go to question ${index + 1}${item.flagged ? ", flagged" : ""}`}
              className="cursor-pointer border border-ink px-3 py-2 font-mono text-xs underline-offset-4 hover:bg-paper-sunk hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
            >
              {pad2(index + 1)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

