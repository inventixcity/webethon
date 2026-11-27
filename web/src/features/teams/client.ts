/**
 * Team calls through the same-origin /api/v1 proxy. Every function throws an ApiError on failure, so the
 * caller can show the message the API wrote. Invite tokens are only ever sent in a request body.
 */
import { ApiError, api } from "@/lib/api/client";
import type { AssignableRole, Invite, Member, Team, TeamRole } from "./types";

export const listTeams = () => api<Team[]>("/teams");

export const createTeam = (name: string) => api<Team>("/teams", { body: { name } });

export const getTeam = (teamId: string) => api<Team>(teamPath(teamId));

export const renameTeam = (teamId: string, name: string) =>
  api<Team>(teamPath(teamId), { method: "PATCH", body: { name } });

export const deleteTeam = (teamId: string) => api(teamPath(teamId), { method: "DELETE" });

/** Leaves the team, or removes someone else when `userId` isn't yours. */
export const removeMember = (teamId: string, userId: string) =>
  api(`${teamPath(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });

export const setMemberRole = (teamId: string, userId: string, role: AssignableRole) =>
  api<{ userId: string; role: TeamRole }>(`${teamPath(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: { role },
  });

/** Hands ownership to another member. The caller becomes an admin. */
export const transferTeam = (teamId: string, userId: string) =>
  api<Team>(`${teamPath(teamId)}/transfer`, { body: { userId } });

export const listInvites = (teamId: string) => api<Invite[]>(`${teamPath(teamId)}/invites`);

export const createInvite = (teamId: string, email: string, role: AssignableRole) =>
  api<Invite>(`${teamPath(teamId)}/invites`, { body: { email, role } });

export const revokeInvite = (teamId: string, inviteId: string) =>
  api(`${teamPath(teamId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });

export const acceptInvite = (token: string) => api<Team>("/teams/invites/accept", { body: { token } });

/**
 * One page of members. `api()` returns only `data`, so this reads the envelope itself to get the cursor,
 * with the same error mapping.
 */
export async function listMembers(teamId: string, cursor?: string): Promise<{ data: Member[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);

  let response: Response;
  try {
    response = await fetch(`/api/v1${teamPath(teamId)}/members?${params}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new ApiError({
      code: "UNAVAILABLE",
      status: 0,
      message: "We can't reach the service right now. Check your connection and try again.",
    });
  }

  const body = (await response.json().catch(() => null)) as {
    data?: Member[];
    meta?: { nextCursor?: string | null };
    error?: { code?: string; message?: string; requestId?: string };
  } | null;
  if (!response.ok) {
    throw new ApiError({
      code: body?.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      message: body?.error?.message ?? "Something went wrong. Please try again.",
      requestId: body?.error?.requestId,
    });
  }
  if (!body || !Array.isArray(body.data)) {
    throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The server returned an invalid response." });
  }
  return { data: body.data, nextCursor: body.meta?.nextCursor ?? null };
}

const teamPath = (teamId: string): `/teams/${string}` => `/teams/${encodeURIComponent(teamId)}`;
