import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Dispute } from "@/lib/exam/types";
import { DisputeStatusBadge } from "./status";
import { formatDay, formatWhen, RESOLUTION_LABEL, scoreChangeText, scoreLine } from "./format";

/**
 * The dispute line under one question in the candidate breakdown. Shows the status and the examiner's answer once a
 * dispute exists; otherwise offers "Dispute this mark" while the window is open.
 */
export function QuestionDispute({
  dispute,
  itemId,
  windowEnd,
  now,
  verifyCode,
  onRaise,
  asCard = false,
}: {
  dispute: Dispute | undefined;
  /** The question's id. Without it the server cannot be asked, so no action is offered. */
  itemId: string | undefined;
  windowEnd: number;
  now: number;
  verifyCode: string;
  onRaise: () => void;
  asCard?: boolean;
}) {
  const windowOpen = now < windowEnd;
  const closedOn = formatDay(new Date(windowEnd).toISOString());
  let content: ReactNode = null;

  if (dispute) {
    const changed = scoreChangeText(dispute.scoreBefore, dispute.scoreAfter) !== null;
    content = (
      <div className="grid gap-3 border-l-2 border-rule pl-4">
        <div className="flex flex-wrap items-center gap-3">
          <DisputeStatusBadge status={dispute.status} />
          <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            Raised {formatWhen(dispute.createdAt)}
          </span>
        </div>
        {dispute.status === "open" ? (
          <p className="text-sm text-ink-soft">Waiting for your examiner&apos;s decision.</p>
        ) : (
          <div className="grid gap-2 text-sm text-ink-soft">
            <p>
              <span className="font-medium text-ink">Examiner&apos;s response:</span>{" "}
              {dispute.response.trim() || "No message was given."}
            </p>
            <p>
              <span className="font-medium text-ink">Outcome:</span>{" "}
              {dispute.status === "rejected" ? "Rejected, the mark stands" : RESOLUTION_LABEL[dispute.resolution]}.{" "}
              <span className="tabular-nums">{scoreLine(dispute)}</span>
            </p>
            {dispute.status === "accepted" && changed ? (
              <p>Your certificate was re-issued with the same code, {verifyCode}.</p>
            ) : null}
            {dispute.resolvedAt ? (
              <p className="font-mono text-[11px] tracking-[0.08em] uppercase">Decided {formatDay(dispute.resolvedAt)}</p>
            ) : null}
          </div>
        )}
      </div>
    );
  } else if (!windowOpen) {
    content = <p className="text-sm text-ink-muted">The dispute window for this question closed on {closedOn}.</p>;
  } else if (itemId) {
    content = (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={onRaise}>
          Dispute this mark
        </Button>
        <p className="text-sm text-ink-muted">Open until {closedOn}. One per question.</p>
      </div>
    );
  }

  if (!content) return null;
  if (asCard) return <div className="min-w-0 border-t border-rule pt-4">{content}</div>;
  return (
    <tr>
      <td />
      <td colSpan={4} className="pb-6">
        {content}
      </td>
    </tr>
  );
}
