import { DisputeStatusBadge } from "./status";
import type { ExaminerDispute } from "./examiner-types";
import { formatMarks, formatWhen, RESOLUTION_LABEL, scoreLine } from "./format";
import { ResolveForm } from "./resolve-form";

/**
 * One dispute in the examiner queue. The script is shown only by its label, never by name. Once it is resolved the
 * card keeps a plain audit line: who decided, when, and the score before and after.
 */
export function DisputeCard({
  dispute,
  onResolved,
}: {
  dispute: ExaminerDispute;
  onResolved: (next: ExaminerDispute) => void;
}) {
  const open = dispute.status === "open";
  const label = dispute.scriptLabel ?? "Script";
  const awarded = dispute.awardedMarks;
  const itemMarks = dispute.itemMarks;

  return (
    <article aria-labelledby={`${dispute.id}-title`} className="grid gap-6 border border-rule bg-paper-raised p-5 md:p-7">
      <header className="grid gap-3 border-b border-rule pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={`${dispute.id}-title`} className="text-2xl leading-none font-medium tracking-[-0.02em]">
            {label}
          </h3>
          <DisputeStatusBadge status={dispute.status} />
        </div>
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase tabular-nums">
          Question {dispute.position}
          {itemMarks !== undefined ? ` · ${formatMarks(itemMarks)} ${itemMarks === 1 ? "mark" : "marks"}` : ""}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
        <div className="grid content-start gap-5">
          <div className="grid gap-2">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Question</p>
            <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{dispute.stem}</p>
          </div>
          <div className="grid gap-2">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Candidate&apos;s reason</p>
            <p className="border-l-2 border-ink pl-4 text-base leading-relaxed break-words whitespace-pre-wrap">{dispute.reason}</p>
          </div>
        </div>

        <dl className="grid content-start gap-4 font-mono text-[11px] tracking-[0.12em] uppercase">
          <div className="grid gap-1">
            <dt className="text-ink-muted">Marks for this question now</dt>
            <dd className="font-sans text-base tracking-normal normal-case tabular-nums">
              {awarded !== undefined && itemMarks !== undefined
                ? `${formatMarks(awarded)} of ${formatMarks(itemMarks)}`
                : "Not sent by the server yet"}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-ink-muted">Attempt score now</dt>
            <dd className="font-sans text-base tracking-normal normal-case tabular-nums">{scoreLine(dispute)}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-ink-muted">Raised</dt>
            <dd className="font-sans text-base tracking-normal normal-case">{formatWhen(dispute.createdAt)}</dd>
          </div>
        </dl>
      </div>

      {open ? (
        <ResolveForm dispute={dispute} onResolved={onResolved} />
      ) : (
        <div className="grid gap-3 border-t border-rule pt-5">
          <p className="text-sm text-ink-soft">
            <span className="font-medium text-ink">Audit:</span>{" "}
            {dispute.status === "rejected" ? "Rejected" : "Accepted"} by {dispute.resolvedBy || "the examiner"} on{" "}
            {formatWhen(dispute.resolvedAt)}. {RESOLUTION_LABEL[dispute.resolution]}. {scoreLine(dispute)}.
          </p>
          <p className="text-sm text-ink-soft">
            <span className="font-medium text-ink">Message to candidate:</span> {dispute.response || "None given."}
          </p>
        </div>
      )}
    </article>
  );
}
