import "server-only";

import { headers } from "next/headers";
import { z } from "zod";
import { ApiError } from "@/lib/api/client";
import type { Profile } from "./types";

const profileResponse = z.object({
  data: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    role: z.string(),
    createdAt: z.string(),
  }),
});

const errorResponse = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }),
});

/**
 * Reads the signed-in person's full profile from the API, server to server, forwarding their cookie.
 * Server components only. The browser never sees the cookie.
 */
export async function getProfile(): Promise<Profile> {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("API_ORIGIN is not set, so the profile can't be loaded.");

  const incoming = await headers();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/me`, {
      headers: {
        accept: "application/json",
        cookie: incoming.get("cookie") ?? "",
        "x-request-id": crypto.randomUUID(),
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

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorResponse.safeParse(body);
    throw new ApiError({
      code: parsed.success && parsed.data.error.code ? parsed.data.error.code : `HTTP_${response.status}`,
      status: response.status,
      message:
        parsed.success && parsed.data.error.message
          ? parsed.data.error.message
          : "Something went wrong. Please try again.",
    });
  }

  const parsed = profileResponse.safeParse(body);
  if (!parsed.success) throw new Error("The API returned a profile in an unexpected shape.");
  return parsed.data.data;
}
