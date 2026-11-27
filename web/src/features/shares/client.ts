/**
 * Share-link calls through the same-origin /api/v1 proxy. Every function throws an ApiError on failure.
 * The share URL carries the secret token: it is returned once by createShare and never logged.
 */
import { api } from "@/lib/api/client";

export type ShareEntity = string;

export type CreateShareInput = {
  entity: ShareEntity;
  recordId: string;
  /** 1..=90, the server default is 30. */
  expiresInDays?: number;
};

/** Returned once by POST /shares. The url contains the token, so keep it out of logs and storage. */
export type CreatedShare = {
  id: string;
  url: string;
  expiresAt: string;
};

/** One row of GET /shares (the caller's own links). The token is never returned again. */
export type Share = {
  id: string;
  entity: ShareEntity;
  recordId: string;
  createdAt: string;
  expiresAt: string;
  /** Set when the link was revoked by its owner. */
  revokedAt?: string | null;
};

export const createShare = (input: CreateShareInput) =>
  api<CreatedShare>("/shares", {
    body: {
      entity: input.entity,
      recordId: input.recordId,
      ...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
    },
  });

/** The caller's live links, newest first. The API pages at 20 by default, so ask for the maximum of 100. */
export const listShares = () => api<Share[]>("/shares?limit=100");

export const revokeShare = (id: string) => api(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
