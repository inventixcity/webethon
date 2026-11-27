import { api, ApiError } from "@/lib/api/client";
import { describeError, type ErrorView } from "@/lib/errors";

export { api, ApiError };
export const recordPath = (entity: string, id: string) => `/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}` as const;
export type Actor = { id?: string; name?: string; displayName?: string } | null;
export type Comment = { id: string; body: string | null; authorId?: string; deletedAt?: string | null; parentId?: string | null; actor?: Actor; author?: Actor; createdAt?: string; canEdit?: boolean; canDelete?: boolean; mine?: boolean };
export type SocialItem = { id: string; kind?: string; action?: string; actor?: Actor; entity?: string; recordId?: string; createdAt?: string; readAt?: string | null; read?: boolean; message?: string };
export function actorName(actor?: Actor) { return actor?.displayName || actor?.name || "Someone"; }
/** Plain copy for a failure. Never the server's or the JS engine's raw text. */
export function errorMessage(error: unknown) { return describeError(error, { context: "action" }).message; }
/** A failed action as a toast. Always a toast, so a fatal code doesn't replace the widget. */
export function toastViewFor(error: unknown): ErrorView { return { ...describeError(error, { context: "action" }), kind: "toast" }; }
export async function page<T>(path: string): Promise<{ data: T[]; meta: { nextCursor: string | null; unreadCount?: number } }> {
  const response = await fetch(`/api/v1${path}`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError({ status: response.status, code: result?.error?.code ?? `HTTP_${response.status}`, message: result?.error?.message ?? "Could not load items." });
  if (!Array.isArray(result?.data) || !result.meta || !(result.meta.nextCursor === null || typeof result.meta.nextCursor === "string") || (path.startsWith("/notifications?") && (typeof result.meta.unreadCount !== "number" || !Number.isFinite(result.meta.unreadCount)))) throw new Error("The server returned an invalid response.");
  if (!result.data.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    const actor = row.actor as Record<string, unknown> | null;
    const nullableString = (value: unknown) => value === null || typeof value === "string";
    return typeof row.id === "string" && typeof row.kind === "string" && !!actor && typeof actor.id === "string" && typeof actor.displayName === "string" && nullableString(row.entity) && nullableString(row.recordId) && nullableString(row.commentId) && typeof row.createdAt === "string" && (path.startsWith("/notifications?") ? nullableString(row.readAt) : nullableString(row.targetUserId));
  })) throw new Error("The server returned an invalid response.");
  return { data: result.data, meta: { nextCursor: result.meta.nextCursor, unreadCount: result.meta.unreadCount } };
}
