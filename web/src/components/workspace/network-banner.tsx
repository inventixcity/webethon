"use client";

import { Activity, CloudOff, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REJECT_REASON, pad2, type JournalRejectReason } from "./model";

export type ConnectionMode = "online" | "unstable" | "offline";

/**
 * Full-width banners for an unstable or lost connection (4.1, 5.3). The copy is literal about what happens:
 * where answers go, that they sync by themselves, and that the clock keeps running, because the server clock
 * is the only clock and is never paused automatically.
 */
export function ConnectionBanner({
  mode,
  journalEnabled,
  simulated,
  onReconnect,
}: {
  mode: ConnectionMode;
  journalEnabled: boolean;
  /** Sandbox demo: offline was simulated from the workspace, not a real drop. */
  simulated: boolean;
  onReconnect: () => void;
}) {
  if (mode === "online") return null;

  if (mode === "unstable") {
    return (
      <div role="status" className="border-b border-(--ws-line) bg-paper-raised">
        <div className="ws-bar flex items-start gap-3 py-3">
          <Activity className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="font-sans text-sm text-ink">
            <strong className="font-semibold">Your connection is unstable.</strong> Answers are saved on this device
            first and retried automatically. <strong className="font-semibold">Your time is not paused.</strong>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div role="status" className="border-b border-ink bg-ink text-paper">
      <div className="ws-bar flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
        <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 font-sans text-sm">
          {simulated && <span className="mr-2 font-mono text-[11px] tracking-[0.12em] uppercase">Demo ·</span>}
          {journalEnabled ? (
            <>
              <strong className="font-semibold">You&apos;re offline. Keep answering.</strong> Every answer is stored on
              this device and syncs by itself when the connection returns.{" "}
              <strong className="font-semibold">Your time is not paused.</strong>
            </>
          ) : (
            <>
              <strong className="font-semibold">You&apos;re offline.</strong> This exam does not allow offline answers,
              so changes made now are not saved until you reconnect. Answers saved before the drop are safe.{" "}
              <strong className="font-semibold">Your time is not paused.</strong>
            </>
          )}
        </p>
        {simulated && (
          <Button type="button" size="sm" variant="inverse" onClick={onReconnect}>
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when the server refused offline journal entries (5.3). It names each reason in plain words and says
 * what still counts, so a candidate is never left guessing whether their work is lost.
 */
export function JournalRejectedNotice({
  reasons,
  questions,
  onDismiss,
}: {
  reasons: JournalRejectReason[];
  /** 0-based positions of the affected questions, when the engine reports them. */
  questions: number[];
  onDismiss: () => void;
}) {
  if (reasons.length === 0) return null;
  return (
    <section role="alert" aria-labelledby="ws-rejected-title" className="border-b border-ink bg-paper-raised">
      <div className="ws-bar grid gap-2 py-4">
        <h2 id="ws-rejected-title" className="flex items-center gap-2 font-sans text-base font-semibold">
          <FileWarning className="size-4 shrink-0" aria-hidden />
          Some answers made offline were not accepted
        </h2>
        <ul className="grid gap-1 font-sans text-sm text-ink-soft">
          {reasons.map((reason) => (
            <li key={reason}>
              <span className="font-mono text-[11px] tracking-[0.1em] text-ink uppercase">{reason}</span> · An answer
              was refused because it {REJECT_REASON[reason]}.
            </li>
          ))}
        </ul>
        <p className="font-sans text-sm text-ink-soft">
          {questions.length > 0
            ? `Affected: question ${questions.map((index) => pad2(index + 1)).join(", ")}. `
            : ""}
          Everything else the server already holds is safe and counts. If time remains, answer the affected questions
          again now; online saves are not affected.
        </p>
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={onDismiss}>
            I understand
          </Button>
        </div>
      </div>
    </section>
  );
}
