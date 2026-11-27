/**
 * The account calls the settings screens make, through the same-origin /api/v1 proxy.
 * Every function throws an ApiError on failure. Callers describe it with describeError (lib/errors), which shows
 * catalogue copy, never the server's raw text.
 */
import { api } from "@/lib/api/client";
import type { Profile, Session } from "./types";

export type MfaStatus = { totpEnabled: boolean; recoveryCodesRemaining: number };
export type MfaSetup = { secret: string; otpauthUrl: string; qrSvg: string };
export const getMfaStatus = () => api<MfaStatus>("/auth/mfa");
export const setupMfa = (currentPassword: string) => api<MfaSetup>("/auth/mfa/totp/setup", { body: { currentPassword } });
export const enableMfa = (code: string) => api<{ recoveryCodes: string[] }>("/auth/mfa/totp/enable", { body: { code } });
export const disableMfa = (currentPassword: string, code: string) => api("/auth/mfa/totp/disable", { body: { currentPassword, code } });
export const regenerateMfaCodes = (currentPassword: string, code: string) => api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { body: { currentPassword, code } });

export type ProfilePatch = {
  displayName?: string;
  /** null removes the avatar. */
  avatarUrl?: string | null;
};

const sessionPath = (id: string): `/auth/sessions/${string}` => `/auth/sessions/${encodeURIComponent(id)}`;

export function updateProfile(patch: ProfilePatch) {
  return api<Profile>("/me", { method: "PATCH", body: patch });
}

/** Signs out every device, including this one. */
export function deleteAccount() {
  return api("/me", { method: "DELETE" });
}

/** Signs out every other device. */
export function changePassword(input: { currentPassword: string; newPassword: string }) {
  return api("/auth/password/change", { method: "POST", body: input });
}

export function listSessions() {
  return api<Session[]>("/auth/sessions");
}

export function revokeSession(id: string) {
  return api(sessionPath(id), { method: "DELETE" });
}

/** Signs out every device, including this one. */
export function signOutEverywhere() {
  return api("/auth/signout-all", { method: "POST" });
}
