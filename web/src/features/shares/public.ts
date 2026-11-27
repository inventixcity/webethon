import "server-only";

import { z } from "zod";
import { ApiError } from "@/lib/api/client";
import { signedVisitorHeaders } from "@/lib/api/forward";
import { headers } from "next/headers";

export type SharedRecord = {
  /** The record's data fields, in the order the API sent them. Never an owner, email or internal id. */
  fields: Record<string, unknown>;
};

const envelope = z.object({ data: z.record(z.string(), z.unknown()) });

/** Keys the API may send beside the data fields. They describe the record and are not shown as fields. */
const META_KEYS = new Set(["id", "entity", "createdAt", "updatedAt"]);

/**
 * Fetches a shared record on the server, with no cache. A missing, revoked or expired link is a 404 from the
 * API, which surfaces here as ApiError with status 404. Other failures carry their own status.
 */
export async function getSharedRecord(token: string): Promise<SharedRecord> {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("API_ORIGIN is not set, so the shared record can't be loaded.");

  const incoming = await headers();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/public/shares/${encodeURIComponent(token)}`, {
      headers: {
        accept: "application/json",
        "x-request-id": crypto.randomUUID(),
        // The public endpoint is rate limited per visitor, so pass the trusted visitor IP through.
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

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const retryHeader = response.headers.get("retry-after");
    const retrySeconds = retryHeader === null ? NaN : Number(retryHeader);
    throw new ApiError({
      code: readErrorCode(body) ?? `HTTP_${response.status}`,
      status: response.status,
      message: "This shared record can't be shown.",
      requestId,
      retryAfter: Number.isFinite(retrySeconds) && retrySeconds >= 0 ? Math.ceil(retrySeconds) : undefined,
    });
  }

  const parsed = envelope.safeParse(body);
  if (!parsed.success) throw new Error("The API returned a shared record in an unexpected shape.");

  return { fields: pickFields(parsed.data.data) };
}

/** Only the error's code is read. The message and details never leave this file. */
function readErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The API returns the record's data fields. Accepts the fields nested under `data`, or flat beside the
 * meta keys, so a change in the wrapper never leaks the meta keys as fields.
 */
function pickFields(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = raw.data;
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : raw;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!META_KEYS.has(key)) fields[key] = value;
  }
  return fields;
}
