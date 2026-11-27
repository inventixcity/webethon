import { api, ApiError } from "@/lib/api/client";
export type FieldSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean | null)[];
  format?: string;
  "x-widget"?: string;
  default?: unknown;
  items?: FieldSchema;
  maxItems?: number;
};
export type Entity = {
  name: string;
  label: string;
  read: string;
  create: string;
  write: string;
  allowPublic: boolean;
  sortable: string[];
  filterable: string[];
  searchable: string[];
  schema: { properties?: Record<string, FieldSchema>; required?: string[] };
};
export type RecordItem = {
  id: string;
  entity: string;
  data: Record<string, unknown>;
  visibility: "public" | "private";
  version: number;
  ownerId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ListOptions = {
  cursor?: string;
  sort?: string;
  filters?: Record<string, string>;
  q?: string;
  scope?: "mine" | "public" | "all" | "team";
  teamId?: string;
  signal?: AbortSignal;
};
type Envelope<T> = { data: T; meta?: { nextCursor?: string | null } };
const path = (entity: string, id?: string): `/${string}` =>
  `/entities/${encodeURIComponent(entity)}${id ? `/${encodeURIComponent(id)}` : ""}`;
function unwrap<T>(value: T | Envelope<T>): T {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value && !("id" in value)
    ? (value as Envelope<T>).data
    : (value as T);
}
export async function listEntities() {
  return unwrap(await api<Entity[] | Envelope<Entity[]>>("/entities"));
}
export async function listRecords(
  entity: string,
  options: ListOptions = {},
): Promise<{ data: RecordItem[]; meta: { nextCursor: string | null } }> {
  if (options.scope === "team" && !options.teamId) throw new Error("Select a team to view team records.");
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.sort) params.set("sort", options.sort);
  if (options.q) params.set("q", options.q);
  if (options.scope) params.set("scope", options.scope);
  if (options.scope === "team" && options.teamId) params.set("teamId", options.teamId);
  Object.entries(options.filters ?? {}).forEach(([key, value]) => {
    if (value !== "") params.set(`filter[${key}]`, value);
  });
  let response: Response;
  try {
    response = await fetch(`/api/v1${path(entity)}?${params}`, {
      credentials: "same-origin",
      signal: options.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError({
      code: "UNAVAILABLE",
      status: 0,
      message: "We can't reach the service right now. Check your connection and try again.",
    });
  }
  const body = (await response.json().catch(() => null)) as
    | (Envelope<RecordItem[]> & { error?: { code?: string; message?: string; details?: unknown; requestId?: string } })
    | null;
  if (!response.ok)
    throw new ApiError({
      code: body?.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      message: body?.error?.message ?? "Something went wrong. Please try again.",
      details: body?.error?.details,
      requestId: body?.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
    });
  if (!body || !Array.isArray(body.data))
    throw new ApiError({
      code: "BAD_RESPONSE",
      status: response.status,
      message: "The server returned an invalid response.",
    });
  return { data: body.data, meta: { nextCursor: body.meta?.nextCursor ?? null } };
}
export async function getRecord(entity: string, id: string) {
  return unwrap(await api<RecordItem | Envelope<RecordItem>>(path(entity, id)));
}
export async function createRecord(entity: string, data: Record<string, unknown>, key = crypto.randomUUID(), teamId?: string | null) {
  return unwrap(
    await api<RecordItem | Envelope<RecordItem>>(path(entity), {
      method: "POST",
      body: teamId ? { data, teamId } : { data },
      headers: { "Idempotency-Key": key },
    }),
  );
}
export async function updateRecord(
  entity: string,
  record: RecordItem,
  patch: { data?: Record<string, unknown>; visibility?: "public" | "private" },
) {
  return unwrap(
    await api<RecordItem | Envelope<RecordItem>>(path(entity, record.id), {
      method: "PATCH",
      body: patch,
      headers: { "If-Match": `"${record.version}"` },
    }),
  );
}
export async function deleteRecord(entity: string, record: RecordItem) {
  return api<void>(path(entity, record.id), { method: "DELETE", headers: { "If-Match": `"${record.version}"` } });
}
