import { ApiError, api } from "@/lib/api/client";

/** A flag as the admin screen sees it. Changes need step-up. */
export type AdminFlag = {
  key: string;
  description: string;
  enabled: boolean;
  /** Whole number, 0 to 100. */
  rollout: number;
  allowEmails: string[];
  allowTeams: string[];
  /** Any JSON value. Undefined or null when none is set. */
  value?: unknown;
  updatedAt: string | null;
};

/** The body of PUT /admin/flags/:key. `value` is left out when there is none. */
export type FlagInput = {
  description: string;
  enabled: boolean;
  rollout: number;
  allowEmails: string[];
  allowTeams: string[];
  value?: unknown;
};

/** What the app reads: only the on/off state and an optional value, evaluated for the viewer. */
export type PublicFlag = { enabled: boolean; value?: unknown };
export type PublicFlags = Record<string, PublicFlag>;

export async function listAdminFlags(): Promise<AdminFlag[]> {
  const data = await api<unknown>("/admin/flags");
  if (!Array.isArray(data)) throw new ApiError({ code: "BAD_RESPONSE", status: 200, message: "The server returned an invalid flag list." });
  return data.filter(isRecord).map(toAdminFlag);
}

/** Creates a flag when the key is new, and replaces it otherwise. Step-up required. */
export function putFlag(key: string, input: FlagInput) {
  return api<void>(`/admin/flags/${encodeURIComponent(key)}`, { method: "PUT", body: input });
}

/** Step-up required. */
export function deleteFlag(key: string) {
  return api<void>(`/admin/flags/${encodeURIComponent(key)}`, { method: "DELETE" });
}

/** Anonymous allowed. Returns the flags evaluated for the viewer. */
export async function getFlags(): Promise<PublicFlags> {
  const data = await api<unknown>("/flags");
  if (!isRecord(data)) throw new ApiError({ code: "BAD_RESPONSE", status: 200, message: "The server returned invalid flags." });
  const flags: PublicFlags = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isRecord(value)) continue;
    flags[key] = { enabled: value.enabled === true, value: value.value };
  }
  return flags;
}

function toAdminFlag(row: Record<string, unknown>): AdminFlag {
  return {
    key: String(row.key ?? ""),
    description: typeof row.description === "string" ? row.description : "",
    enabled: row.enabled === true,
    rollout: typeof row.rollout === "number" && Number.isFinite(row.rollout) ? row.rollout : 0,
    allowEmails: stringArray(row.allowEmails),
    allowTeams: stringArray(row.allowTeams),
    value: row.value === null ? undefined : row.value,
    updatedAt: typeof row.updatedAt === "string" && row.updatedAt !== "" ? row.updatedAt : null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
