import type { NextRequest } from "next/server";
import { signedVisitorHeaders } from "@/lib/api/forward";

/**
 * Forwards /api/v1/* to the Rust API, server to server. The browser only ever talks to this origin,
 * so session cookies stay first-party and no CORS is needed.
 *
 * The visitor's IP is passed on signed with PROXY_SECRET, so the API can rate limit per person
 * without trusting a header anyone could forge.
 */

const REQUEST_HEADERS = [
  "accept",
  "if-none-match",
  "last-event-id",
  "authorization",
  "content-type",
  "cookie",
  "idempotency-key",
  "if-match",
  "origin",
  "sec-fetch-site",
  // Stripe signs the raw webhook body with this header; the body is forwarded byte for byte, so it still verifies.
  "stripe-signature",
  "user-agent",
  "x-request-id",
];

const RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-security-policy",
  "content-type",
  "etag",
  "location",
  "ratelimit-remaining",
  "retry-after",
  "x-accel-buffering",
  "x-content-type-options",
  "x-export-row-limit",
  "x-request-id",
  // The API sends this on public share pages; browsers and crawlers need it.
  "x-robots-tag",
];

const MAX_BODY_BYTES = 1_048_576;
// Uploads get more room, but stay under Vercel's 4.5 MB request limit.
const MAX_UPLOAD_BYTES = 4 * 1_048_576;
const TIMEOUT_MS = 15_000;

function failure(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/** POST to `files` and POST to `entities/<entity>/import` take uploads; every other body gets the small limit. */
function bodyLimit(path: string[], method: string): number {
  if (method !== "POST") return MAX_BODY_BYTES;
  const upload =
    (path.length === 1 && path[0] === "files") ||
    (path.length === 3 && path[0] === "entities" && path[2] === "import");
  return upload ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
}

/** Long-lived streams. No deadline: the client leaving is what ends them. AI enforces its own deadline upstream. */
function isStream(path: string[], method: string): boolean {
  return (path.at(-1) === "events" && method === "GET")
    || (path.length === 2 && path[0] === "ai" && (path[1] === "chat" || path[1] === "complete") && method === "POST")
    || (path.length === 2 && path[0] === "assist" && path[1] === "ask" && method === "POST");
}

/**
 * Downloads. The 200 goes out with the headers, so the body can run longer than TIMEOUT_MS; only the wait
 * for headers has a deadline.
 */
function isDownload(path: string[], method: string): boolean {
  return method === "GET"
    && path.length === 3
    && ((path[0] === "entities" && path[2] === "export") || (path[0] === "files" && path[2] === "content"));
}

const BODY_DEADLINE_MS = 10_000;

/**
 * Reads the body chunk by chunk and stops as soon as it passes the limit or the deadline, so an
 * oversized or trickled body (e.g. chunked with no Content-Length) is never fully buffered.
 */
async function readBody(request: NextRequest, limit: number): Promise<ArrayBuffer | "too-large" | "too-slow"> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + BODY_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "too-slow";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (next === "timeout") return "too-slow";
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) return "too-large";
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) return failure(503, "NOT_CONFIGURED", "The API isn't connected yet.");

  const { path } = await context.params;
  // Each segment is re-encoded, so "..", encoded slashes and the like can't escape /api/v1 upstream.
  if (path.some((segment) => segment === "." || segment === ".." || segment.length > 200)) {
    return failure(404, "NOT_FOUND", "We couldn't find that.");
  }
  const target = `${origin}/api/v1/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(signedVisitorHeaders(request.headers))) headers.set(name, value);

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const limit = bodyLimit(path, request.method);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > limit) return failure(413, "PAYLOAD_TOO_LARGE", "That request is too large.");
    const read = await readBody(request, limit);
    if (read === "too-large") return failure(413, "PAYLOAD_TOO_LARGE", "That request is too large.");
    if (read === "too-slow") return failure(408, "BAD_REQUEST", "The request took too long to arrive.");
    body = read;
  }

  // Streams follow the client; downloads get a deadline only until headers arrive; everything else gets TIMEOUT_MS.
  let signal: AbortSignal;
  let headersDeadline: ReturnType<typeof setTimeout> | undefined;
  let deadlineHit = false;
  if (isStream(path, request.method)) {
    signal = request.signal;
  } else if (isDownload(path, request.method)) {
    const expiry = new AbortController();
    headersDeadline = setTimeout(() => {
      deadlineHit = true;
      expiry.abort();
    }, TIMEOUT_MS);
    // Still linked to the client, so a visitor who leaves cancels the upstream body too.
    signal = AbortSignal.any([request.signal, expiry.signal]);
  } else {
    signal = AbortSignal.timeout(TIMEOUT_MS);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    const timedOut = deadlineHit || (error instanceof DOMException && error.name === "TimeoutError");
    console.error("api proxy failed", timedOut ? "timeout" : error);
    return timedOut
      ? failure(504, "UNAVAILABLE", "The service took too long to answer. Please try again.")
      : failure(502, "UNAVAILABLE", "The service is unreachable right now. Please try again.");
  } finally {
    // Headers have arrived (or the call failed), so the deadline is over. The body may take as long as it needs.
    clearTimeout(headersDeadline);
  }

  // Upstream decides caching (file downloads may be cacheable); everything else defaults to no-store.
  const out = new Headers({ "cache-control": "no-store" });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
