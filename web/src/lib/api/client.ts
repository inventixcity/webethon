/**
 * Typed fetch for the Rust API, called through the same-origin /api/v1 proxy.
 *
 * The browser only talks to its own origin, so the HttpOnly session cookie is first-party and JavaScript
 * never sees it. Request and response bodies are never logged: they can hold passwords and codes.
 */

const BASE_PATH = "/api/v1";
const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const UNAVAILABLE_MESSAGE = "We can't reach the service right now. Check your connection and try again.";

export class ApiError extends Error {
  readonly code: string;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying, when the server sent Retry-After. */
  readonly retryAfter: number | undefined;

  constructor(init: {
    code: string;
    status: number;
    message: string;
    details?: unknown;
    requestId?: string;
    retryAfter?: number;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
  }
}

export type ApiOptions = {
  /** Defaults to POST when there is a body, and GET when there isn't. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Calls `/api/v1{path}` and returns the envelope's `data`.
 * Throws an ApiError for every failure, including network failures (code UNAVAILABLE).
 */
export async function api<T = void>(path: `/${string}`, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const requestId = newRequestId();

  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("x-request-id", requestId);

  let payload: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(options.body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BASE_PATH}${path}`, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      cache: "no-store",
      // The JSON API never redirects. If it does, treat that as a failure rather than follow it.
      redirect: "error",
    });
    text = await response.text();
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: UNAVAILABLE_MESSAGE, requestId });
  }

  const serverRequestId = response.headers.get("x-request-id") ?? requestId;
  const envelope = parseJson(text);

  if (!response.ok) {
    const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;
    throw new ApiError({
      code: typeof error?.code === "string" ? error.code : `HTTP_${response.status}`,
      status: response.status,
      message: typeof error?.message === "string" && error.message ? error.message : GENERIC_MESSAGE,
      details: error?.details,
      requestId: typeof error?.requestId === "string" ? error.requestId : serverRequestId,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  // 204 and empty 202 responses have no body.
  if (text === "") return undefined as T;
  if (!isRecord(envelope)) {
    throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: GENERIC_MESSAGE, requestId: serverRequestId });
  }
  return envelope.data as T;
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retry-After is either a number of seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * randomUUID only exists in secure contexts, so a page opened over plain http on a LAN address
 * falls back to random bytes shaped like a version 4 UUID.
 */
function newRequestId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
