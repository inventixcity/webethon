import { adminList, type Row } from "@/features/admin/client";
import { api } from "@/lib/api/client";

/** Background job states, as the admin list filters them. */
export const JOB_STATUSES = ["queued", "running", "done", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Job = {
  id: string;
  kind: string;
  /** "unknown" when the server sends a status this screen does not know. */
  status: JobStatus | "unknown";
  attempts: number;
  maxAttempts: number | null;
  runAt: string | null;
  /** Plain text from the server, already truncated and free of secrets. Shown as text, never as HTML. */
  lastError: string | null;
  createdAt: string | null;
  finishedAt: string | null;
};

export type JobFilters = { status?: string; kind?: string };

export const JOB_PAGE_SIZE = 25;

/** One page of jobs, newest first. Pass the previous `nextCursor` to go on. */
export async function listJobs(filters: JobFilters, cursor?: string): Promise<{ data: Job[]; nextCursor: string | null }> {
  const list = await adminList("/admin/jobs", {
    status: filters.status ?? "",
    kind: filters.kind ?? "",
    limit: String(JOB_PAGE_SIZE),
    cursor: cursor ?? "",
  });
  return { data: list.data.map(toJob), nextCursor: list.meta.nextCursor };
}

/** Step-up required. Callers handle isStepUpRequired from features/admin/client. */
export function retryJob(id: string) {
  return api<void>(`/admin/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

/** Step-up required. Callers handle isStepUpRequired from features/admin/client. */
export function cancelJob(id: string) {
  return api<void>(`/admin/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/** Reads a server row defensively, so a missing or odd field shows as empty, never as a crash. */
function toJob(row: Row): Job {
  const status = typeof row.status === "string" && (JOB_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as JobStatus)
    : "unknown";
  return {
    id: String(row.id ?? ""),
    kind: typeof row.kind === "string" && row.kind ? row.kind : "unknown",
    status,
    attempts: numberOr(row.attempts, 0),
    maxAttempts: typeof row.maxAttempts === "number" ? row.maxAttempts : null,
    runAt: stringOrNull(row.runAt),
    lastError: stringOrNull(row.lastError),
    createdAt: stringOrNull(row.createdAt),
    finishedAt: stringOrNull(row.finishedAt),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
