import { ApiError } from "@/lib/api/client";

/** Roles as people see them. The API stores a candidate as `user`. */
export type UserRole = "candidate" | "examiner" | "admin";
export type ApiRole = "user" | "examiner" | "admin";

export const ROLE_LABEL: Record<UserRole, string> = { candidate: "Candidate", examiner: "Examiner", admin: "Admin" };
export const ROLE_CHOICES: UserRole[] = ["candidate", "examiner", "admin"];

/** The value the API expects for a role choice. */
export function toApiRole(role: UserRole): ApiRole {
  return role === "candidate" ? "user" : role;
}

/** A role from the API (`user`, `candidate`, `examiner` or `admin`) as a display role. */
export function presentRole(value: unknown): UserRole | null {
  if (value === "user" || value === "candidate") return "candidate";
  if (value === "examiner" || value === "admin") return value;
  return null;
}

export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  storedRole?: string;
  status: "active" | "suspended";
  deletedAt?: string | null;
  emailVerifiedAt?: string | null;
  createdAt: string;
  mfa?: boolean;
};

export type UsersPageEnvelope = { data: AdminUserRow[]; meta: { nextCursor: string | null } };

export const STATUS_FILTERS = ["", "active", "suspended", "deleted"] as const;
export const ROLE_FILTERS = ["", "candidate", "examiner", "admin"] as const;

/**
 * The user list. The API wraps rows as `{data, meta}`, so this reads the envelope itself and keeps the cursor.
 * `api()` returns only `data`, which would drop the cursor.
 */
export async function listUsers(filters: Record<string, string>, cursor: string | null): Promise<UsersPageEnvelope> {
  const query = new URLSearchParams({ limit: "25" });
  for (const [name, value] of Object.entries(filters)) {
    if (value) query.set(name, value);
  }
  if (cursor) query.set("cursor", cursor);

  let response: Response;
  try {
    response = await fetch(`/api/v1/admin/users?${query.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "We can't reach the service right now." });
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body ? (body as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new ApiError({
      code: typeof error?.code === "string" ? error.code : `HTTP_${response.status}`,
      status: response.status,
      message: typeof error?.message === "string" ? error.message : "Could not load users.",
    });
  }

  const envelope = body as Partial<UsersPageEnvelope> | null;
  if (!envelope || !Array.isArray(envelope.data) || !envelope.meta) {
    throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The server returned an invalid list." });
  }
  return { data: envelope.data, meta: { nextCursor: envelope.meta.nextCursor ?? null } };
}

/** True when the server wants the admin to verify their identity before the action. */
export function needsStepUp(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 428 || error.code === "PRECONDITION_REQUIRED" || error.code === "STEP_UP_REQUIRED");
}
