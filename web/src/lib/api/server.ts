import "server-only";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";
import { ApiError } from "./client";
import { signedVisitorHeaders } from "./forward";

const sessionResponse = z.object({
  data: z.object({
    user: z
      .object({
        id: z.string(),
        email: z.string(),
        displayName: z.string(),
        role: z.string(),
      })
      .nullable(),
  }),
});

export type SessionUser = NonNullable<z.infer<typeof sessionResponse>["data"]["user"]>;

const onboardingResponse = z.object({
  data: z.object({ completedAt: z.string().nullable() }),
});

/** Checks the API's completion flag using the same signed visitor context as the session check. */
export const getOnboardingCompleted = cache(async (): Promise<boolean> => {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("API_ORIGIN is not set, so onboarding can't be checked.");

  const incoming = await headers();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/onboarding`, {
      headers: {
        accept: "application/json",
        cookie: incoming.get("cookie") ?? "",
        "x-request-id": crypto.randomUUID(),
        ...signedVisitorHeaders(incoming),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "We can't reach the service right now. Check your connection and try again." });
  }
  if (!response.ok) throw new Error(`The onboarding check failed with status ${response.status}.`);
  const parsed = onboardingResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("The API returned an onboarding response in an unexpected shape.");
  return parsed.data.data.completedAt !== null;
});

/**
 * Asks the API who the visitor is, server to server, forwarding their cookie.
 * Returns null when nobody is signed in. Cached per request, so a layout and its page share one call.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("API_ORIGIN is not set, so the session can't be checked.");

  const incoming = await headers();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/auth/session`, {
      headers: {
        accept: "application/json",
        cookie: incoming.get("cookie") ?? "",
        "x-request-id": crypto.randomUUID(),
        // Without this, every server-rendered check would share this server's IP budget at the API.
        ...signedVisitorHeaders(incoming),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError({
      code: "UNAVAILABLE",
      status: 0,
      message: "We can't reach the service right now. Check your connection and try again.",
    });
  }

  if (!response.ok) throw new Error(`The session check failed with status ${response.status}.`);

  const parsed = sessionResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("The API returned a session response in an unexpected shape.");
  return parsed.data.data.user;
});
