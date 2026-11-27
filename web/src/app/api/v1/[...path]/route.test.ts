import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

// forward.ts imports server-only, which throws outside the React server build.
vi.mock("server-only", () => ({}));

const MiB = 1_048_576;
const TIMEOUT_MS = 15_000;

type Method = "GET" | "POST";

let upstreamFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("API_ORIGIN", "http://api.test");
  upstreamFetch = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstreamFetch);
  // The proxy logs failures; keep the test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Calls the route exactly as Next does: `path` is the catch-all segments under /api/v1. */
function call(method: Method, path: string, init: { headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {}) {
  const request = new NextRequest(`http://localhost:3000/api/v1/${path}`, { method, headers: init.headers, body: init.body });
  const handler = method === "GET" ? GET : POST;
  return handler(request, { params: Promise.resolve({ path: path.split("/") }) });
}

/** Headers as the upstream received them. */
function upstreamHeaders(callIndex = 0): Headers {
  const [, init] = upstreamFetch.mock.calls[callIndex] as unknown as [string, RequestInit];
  return new Headers(init.headers);
}

describe("Stripe webhooks", () => {
  it("forwards stripe-signature and the raw body byte for byte", async () => {
    const body = new TextEncoder().encode('{"id":"evt_1","type":"invoice.paid"}\n');
    const response = await call("POST", "billing/webhook", {
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
      body,
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders().get("stripe-signature")).toBe("t=1,v1=abc");
    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v1/billing/webhook");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(body);
  });
});

describe("request body limits", () => {
  it("accepts a 2 MiB entity import", async () => {
    const response = await call("POST", "entities/records/import", {
      headers: { "content-type": "text/csv" },
      body: new Uint8Array(2 * MiB),
    });

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a 5 MiB entity import with 413 and never calls the API", async () => {
    const response = await call("POST", "entities/records/import", {
      headers: { "content-type": "text/csv" },
      body: new Uint8Array(5 * MiB),
    });

    expect(response.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an entity import whose declared content-length is over the limit, before reading it", async () => {
    const response = await call("POST", "entities/records/import", {
      headers: { "content-type": "text/csv", "content-length": String(5 * MiB) },
      body: new Uint8Array(16),
    });

    expect(response.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("keeps the 1 MiB limit for other POSTs under entities", async () => {
    const response = await call("POST", "entities/records", { body: new Uint8Array(2 * MiB) });

    expect(response.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("keeps the upload limit for files POST", async () => {
    const response = await call("POST", "files", { body: new Uint8Array(3 * MiB) });

    expect(response.status).toBe(200);
  });
});

describe("downloads", () => {
  it("does not cut an export off once its headers have arrived", async () => {
    vi.useFakeTimers();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => (push = controller) });
    upstreamFetch.mockImplementationOnce(async () => new Response(stream, { status: 200, headers: { "content-type": "text/csv" } }));

    const response = await call("GET", "entities/records/export");
    expect(response.status).toBe(200);

    const signal = (upstreamFetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal as AbortSignal;
    // The body runs well past the header deadline.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(signal.aborted).toBe(false);

    push.enqueue(new TextEncoder().encode("id,name\n"));
    push.close();
    expect(await response.text()).toBe("id,name\n");
  });

  it("does not cut a file download off once its headers have arrived", async () => {
    vi.useFakeTimers();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => (push = controller) });
    upstreamFetch.mockImplementationOnce(async () => new Response(stream, { status: 200 }));

    const response = await call("GET", "files/f_123/content");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    push.enqueue(new Uint8Array([1, 2, 3]));
    push.close();

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  // Real clock on purpose: AbortSignal.timeout runs on Node's own timers, which fake timers don't control.
  // The old whole-body timeout cut this download off at 15 s; this test fails if that comes back.
  it("does not cut a download off at 15 s on the real clock", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    // Like undici: an abort after the headers errors the body, so the test fails if the proxy aborts late.
    upstreamFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          push = controller;
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/csv" } });
    });

    const response = await call("GET", "entities/records/export");
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + 1_000));
    push.enqueue(new TextEncoder().encode("late\n"));
    push.close();

    expect(await response.text()).toBe("late\n");
  }, TIMEOUT_MS + 10_000);

  it("gives up with 504 when the headers never arrive within the deadline", async () => {
    vi.useFakeTimers();
    upstreamFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const pending = call("GET", "entities/records/export");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect((await pending).status).toBe(504);
  });
});

describe("response and request headers", () => {
  it("forwards x-robots-tag from the API", async () => {
    upstreamFetch.mockImplementationOnce(async () => new Response("<html></html>", { status: 200, headers: { "x-robots-tag": "noindex, nofollow" } }));

    const response = await call("GET", "public/shares/abc");

    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("does not forward x-auth-mode to the API", async () => {
    await call("POST", "auth/signin", { headers: { "content-type": "application/json", "x-auth-mode": "bearer" }, body: new TextEncoder().encode("{}") });

    expect(upstreamHeaders().get("x-auth-mode")).toBeNull();
  });
});
