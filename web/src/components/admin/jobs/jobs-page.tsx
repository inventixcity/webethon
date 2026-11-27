"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog, Filters, PageHeading, Pagination, Status, StepUpModal, type Action } from "@/components/admin/workspace";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { isStepUpRequired } from "@/features/admin/client";
import { actionToast } from "@/features/admin/errors";
import { cancelJob, JOB_STATUSES, listJobs, retryJob, type Job, type JobFilters, type JobStatus } from "@/features/jobs/client";
import { formatDateTime, truncate } from "./format";
import { JobStatusLabel } from "./status-label";

const LAST_ERROR_MAX = 160;
const FILTERS: [string, string, string[]?][] = [["status", "Status", [...JOB_STATUSES]], ["kind", "Kind"]];

type ActionName = "retry" | "cancel";

/** Retry applies to jobs that gave up. Cancel applies to jobs still waiting to run. */
const ACTIONS: Record<ActionName, { label: string; title: string; done: string; applies: (status: Job["status"]) => boolean; call: (id: string) => Promise<void> }> = {
  retry: {
    label: "Retry",
    title: "Retry job",
    done: "The job is queued to run again.",
    applies: (status) => status === "failed" || status === "dead",
    call: retryJob,
  },
  cancel: {
    label: "Cancel",
    title: "Cancel job",
    done: "The job was cancelled.",
    applies: (status: JobStatus | "unknown") => status === "queued",
    call: cancelJob,
  },
};

export function JobsPage() {
  const toast = useToast();
  const [filters, setFilters] = useState<JobFilters>({});
  const [cursors, setCursors] = useState<string[]>([""]);
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<Job[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<{ name: ActionName; job: Job } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    listJobs(filters, cursors[index])
      .then((page) => {
        if (!live) return;
        setRows(page.data);
        setNext(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [filters, cursors, index, version]);

  function applyFilters(values: Record<string, string>) {
    setFilters(values);
    setCursors([""]);
    setIndex(0);
  }

  async function confirm() {
    if (!pending) return;
    const action = ACTIONS[pending.name];
    setBusy(true);
    try {
      await action.call(pending.job.id);
      toast.success(action.done);
      setPending(null);
      setVersion((value) => value + 1);
    } catch (cause) {
      // Step-up keeps the confirmation open, so the same action can be confirmed again after verifying.
      if (isStepUpRequired(cause)) {
        setStepUp(true);
      } else {
        setPending(null);
        toast.error(actionToast(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  const dialogAction: Action | null = pending
    ? {
        title: ACTIONS[pending.name].title,
        target: `${pending.job.kind} (${pending.job.id.slice(0, 8)})`,
        path: `/admin/jobs/${encodeURIComponent(pending.job.id)}/${pending.name}`,
      }
    : null;

  return (
    <>
      <PageHeading title="Jobs" description="Background work such as email and webhook delivery. Retry jobs that gave up, or cancel queued ones." />
      <Filters fields={FILTERS} onApply={applyFilters} />
      <Status loading={loading} error={error} empty={!loading && !error && rows.length === 0} onRetry={() => setVersion((value) => value + 1)} />
      {!loading && !error && rows.length > 0 && (
        <>
          <JobTable rows={rows} onAction={(name, job) => setPending({ name, job })} />
          <Pagination
            previous={index > 0}
            next={next !== null}
            onPrevious={() => setIndex(index - 1)}
            onNext={() => {
              if (next === null) return;
              setCursors([...cursors.slice(0, index + 1), next]);
              setIndex(index + 1);
            }}
          />
        </>
      )}
      {dialogAction && !stepUp && (
        <ConfirmDialog action={dialogAction} busy={busy} onCancel={() => setPending(null)} onConfirm={confirm} />
      )}
      {stepUp && (
        <StepUpModal
          onCancel={() => {
            setStepUp(false);
            setPending(null);
          }}
          onSuccess={() => {
            setStepUp(false);
            toast.info("Identity verified. Confirm the action to continue.");
          }}
        />
      )}
    </>
  );
}

function JobTable({ rows, onAction }: { rows: Job[]; onAction: (name: ActionName, job: Job) => void }) {
  const headings = ["Kind", "Status", "Attempts", "Run at", "Last error", "Created", "Finished", "Actions"];
  const names = Object.keys(ACTIONS) as ActionName[];
  return (
    <div className="overflow-x-auto border border-rule">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead className="bg-paper-sunk">
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading} className="px-4 py-3 font-semibold">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((job, position) => {
            const available = names.filter((name) => ACTIONS[name].applies(job.status));
            return (
              <tr key={job.id || position} className="border-t border-rule">
                <td className="max-w-48 px-4 py-3 align-top font-mono text-xs break-all">{job.kind}</td>
                <td className="px-4 py-3 align-top">
                  <JobStatusLabel status={job.status} />
                </td>
                <td className="px-4 py-3 align-top tabular-nums">
                  {job.maxAttempts !== null ? `${job.attempts} of ${job.maxAttempts}` : job.attempts}
                </td>
                <td className="px-4 py-3 align-top whitespace-nowrap">{formatDateTime(job.runAt)}</td>
                <td className="max-w-72 px-4 py-3 align-top break-words text-ink-soft">{truncate(job.lastError, LAST_ERROR_MAX)}</td>
                <td className="px-4 py-3 align-top whitespace-nowrap">{formatDateTime(job.createdAt)}</td>
                <td className="px-4 py-3 align-top whitespace-nowrap">{formatDateTime(job.finishedAt)}</td>
                <td className="px-4 py-3 align-top">
                  {available.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {available.map((name) => (
                        <Button key={name} variant="secondary" size="sm" onClick={() => onAction(name, job)}>
                          {ACTIONS[name].label}
                          <span className="sr-only"> job {job.kind}</span>
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-ink-muted">None</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
