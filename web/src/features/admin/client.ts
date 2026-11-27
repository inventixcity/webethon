import { api, ApiError } from "@/lib/api/client";
export { ApiError };
export type Row = Record<string, unknown>;
export type ListEnvelope = { data: Row[]; meta: { nextCursor: string | null } };
export const adminApi = api;
export const isStepUpRequired = (error: unknown) => error instanceof ApiError && (error.status === 428 || error.code === "PRECONDITION_REQUIRED" || error.code === "STEP_UP_REQUIRED");
export function queryString(filters: Record<string, string>) { const q = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value); const s = q.toString(); return s ? `?${s}` : ""; }
export async function adminList(path: string, filters: Record<string, string>): Promise<ListEnvelope> {
  let response: Response;
  try { response = await fetch(`/api/v1${path}${queryString(filters)}`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } }); }
  catch { throw new ApiError({ status: 0, code: "UNAVAILABLE", message: "Could not reach the service." }); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError({ status: response.status, code: body?.error?.code ?? `HTTP_${response.status}`, message: body?.error?.message ?? "Could not load results." });
  if (!Array.isArray(body?.data) || !body?.meta || !(body.meta.nextCursor === null || typeof body.meta.nextCursor === "string")) throw new ApiError({ status: response.status, code: "BAD_RESPONSE", message: "The server returned an invalid list." });
  return body as ListEnvelope;
}

/** Domain action request bodies: transfer ownership sends { userId: string }.
 * Content hide/unhide/delete/restore, comment hide/delete, booking cancel, and file DELETE send no body. */
export type TransferOwnerBody = { userId: string };

/** Planned domain requests: grant { userId, productId, expiresAt? }; revoke { userId, productId }.
 * Place hide sends no body. Purchases, entitlements, and places use bounded list envelopes. */
export type EntitlementGrantBody = { userId: string; productId: string; expiresAt?: string };
export type EntitlementRevokeBody = { userId: string; productId: string };
