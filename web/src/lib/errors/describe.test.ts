import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { CATALOGUE, GENERIC_ENTRY } from "./catalogue";
import { describeError, messageFor, validationField } from "./describe";
import { ERROR_PAGE_CODES, type ErrorPageCode } from "./types";

type BackendRow = [code: string, status: number, page: ErrorPageCode];

/** Every ErrorCode in crates/kernel/src/error.rs, with its HTTP status and the page it maps to. */
const BACKEND: BackendRow[] = [
  ["BAD_REQUEST", 400, 400],
  ["VALIDATION_FAILED", 400, 400],
  ["UNAUTHENTICATED", 401, 401],
  ["INVALID_CREDENTIALS", 401, 401],
  ["INVALID_CODE", 401, 401],
  ["EMAIL_NOT_VERIFIED", 403, 403],
  ["MFA_REQUIRED", 403, 403],
  ["FORBIDDEN", 403, 403],
  ["ACCOUNT_SUSPENDED", 403, 403],
  ["CSRF_REJECTED", 403, 403],
  ["NOT_FOUND", 404, 404],
  ["METHOD_NOT_ALLOWED", 405, 405],
  ["CONFLICT", 409, 409],
  ["VERSION_CONFLICT", 409, 409],
  ["PRECONDITION_REQUIRED", 428, 428],
  ["IDEMPOTENCY_MISMATCH", 422, 422],
  ["WEAK_PASSWORD", 422, 422],
  ["LIMIT_REACHED", 422, 422],
  ["PAYLOAD_TOO_LARGE", 413, 413],
  ["UNSUPPORTED_MEDIA_TYPE", 415, 415],
  ["RATE_LIMITED", 429, 429],
  ["NOT_CONFIGURED", 503, 503],
  ["UNAVAILABLE", 503, 503],
  ["INTERNAL", 500, 500],
];

/** Codes that replace the whole screen when the context is "page" or "action". */
const FATAL = new Set([
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "ACCOUNT_SUSPENDED",
  "CSRF_REJECTED",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "VERSION_CONFLICT",
  "PRECONDITION_REQUIRED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "INTERNAL",
  "NOT_CONFIGURED",
  "UNAVAILABLE",
]);

/** Codes that can sit inline in a form. Everything else is a toast in a form. */
const FIELD_BOUND = new Set(["VALIDATION_FAILED", "WEAK_PASSWORD", "INVALID_CREDENTIALS", "INVALID_CODE"]);

function apiError(code: string, status: number, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({ code, status, message: "Server text", requestId: "req-1", ...extra });
}

function setOnline(online: boolean) {
  vi.stubGlobal("navigator", { onLine: online });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeError: every backend code, page context", () => {
  it.each(BACKEND)("%s maps to the right kind and page", (code, status, page) => {
    const view = describeError(apiError(code, status), { context: "page" });

    expect(view.code).toBe(code);
    expect(view.page).toBe(page);
    expect(view.kind).toBe(FATAL.has(code) ? "page" : "toast");
    expect(ERROR_PAGE_CODES).toContain(view.page);
  });
});

describe("describeError: every backend code, action context", () => {
  it.each(BACKEND)("%s is a page only when fatal", (code, status, page) => {
    const view = describeError(apiError(code, status), { context: "action" });

    expect(view.kind).toBe(FATAL.has(code) ? "page" : "toast");
    expect(view.page).toBe(page);
  });
});

describe("describeError: every backend code, form context", () => {
  it.each(BACKEND.filter(([code]) => !FIELD_BOUND.has(code)))("%s is a toast in a form", (code, status) => {
    const view = describeError(apiError(code, status), { context: "form", fields: ["title"] });

    expect(view.kind).toBe("toast");
  });
});

describe("field-bound codes in a form", () => {
  it("VALIDATION_FAILED names the field by exact path", () => {
    const cause = apiError("VALIDATION_FAILED", 400, {
      details: [{ path: "title", message: "Required" }],
    });
    const view = describeError(cause, { context: "form", fields: ["title", "tags"] });

    expect(view.kind).toBe("field");
    expect(view.field).toBe("title");
  });

  it("VALIDATION_FAILED matches a dotted path by its first segment", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: [{ path: "tags.2", message: "Too long" }] });
    const view = describeError(cause, { context: "form", fields: ["title", "tags"] });

    expect(view.kind).toBe("field");
    expect(view.field).toBe("tags");
  });

  it("VALIDATION_FAILED prefers an exact name over a first-segment match", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: [{ path: "address.zip" }] });
    const view = describeError(cause, { context: "form", fields: ["address", "address.zip"] });

    expect(view.field).toBe("address.zip");
  });

  it("VALIDATION_FAILED accepts a leading slash path and a field key", () => {
    const slash = apiError("VALIDATION_FAILED", 400, { details: [{ path: "/title" }] });
    const field = apiError("VALIDATION_FAILED", 400, { details: [{ field: "title" }] });

    expect(describeError(slash, { context: "form", fields: ["title"] }).field).toBe("title");
    expect(describeError(field, { context: "form", fields: ["title"] }).field).toBe("title");
  });

  it("VALIDATION_FAILED takes the first path that matches a field", () => {
    const cause = apiError("VALIDATION_FAILED", 400, {
      details: [{ path: "unknown" }, { path: "tags.1" }, { path: "title" }],
    });
    const view = describeError(cause, { context: "form", fields: ["title", "tags"] });

    expect(view.field).toBe("tags");
  });

  it("VALIDATION_FAILED with no matching field is a toast", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: [{ path: "elsewhere" }] });
    const view = describeError(cause, { context: "form", fields: ["title"] });

    expect(view.kind).toBe("toast");
    expect(view.field).toBeUndefined();
  });

  it("VALIDATION_FAILED without fields is a toast", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: [{ path: "title" }] });

    expect(describeError(cause, { context: "form" }).kind).toBe("toast");
  });

  it("VALIDATION_FAILED accepts the record form of details", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: { title: "Required" } });
    const view = describeError(cause, { context: "form", fields: ["title"] });

    expect(view.field).toBe("title");
  });

  it("WEAK_PASSWORD is a field error on password, with the plain message", () => {
    const view = describeError(apiError("WEAK_PASSWORD", 422), { context: "form", fields: ["password"] });

    expect(view.kind).toBe("field");
    expect(view.field).toBe("password");
    expect(view.message).toBe("That password is too easy to guess. Try a longer one.");
  });

  it("WEAK_PASSWORD outside a form is a toast on the 422 page", () => {
    const view = describeError(apiError("WEAK_PASSWORD", 422), { context: "page" });

    expect(view.kind).toBe("toast");
    expect(view.page).toBe(422);
  });

  it("INVALID_CREDENTIALS prefers the password field", () => {
    const view = describeError(apiError("INVALID_CREDENTIALS", 401), {
      context: "form",
      fields: ["email", "password"],
    });

    expect(view.kind).toBe("field");
    expect(view.field).toBe("password");
  });

  it("INVALID_CREDENTIALS falls back to the first given field", () => {
    const view = describeError(apiError("INVALID_CREDENTIALS", 401), { context: "form", fields: ["email"] });

    expect(view.field).toBe("email");
  });

  it("INVALID_CREDENTIALS without fields is a toast", () => {
    expect(describeError(apiError("INVALID_CREDENTIALS", 401), { context: "form" }).kind).toBe("toast");
  });

  it("INVALID_CODE attaches to the code field when one is given", () => {
    const view = describeError(apiError("INVALID_CODE", 401), { context: "form", fields: ["code"] });

    expect(view.kind).toBe("field");
    expect(view.field).toBe("code");
  });
});

describe("flow states", () => {
  it("MFA_REQUIRED is a toast, never a page, in every context", () => {
    for (const context of ["form", "action", "page"] as const) {
      const view = describeError(apiError("MFA_REQUIRED", 403), { context });

      expect(view.kind).toBe("toast");
    }
  });

  it("EMAIL_NOT_VERIFIED is a toast, never a page, in every context", () => {
    for (const context of ["form", "action", "page"] as const) {
      const view = describeError(apiError("EMAIL_NOT_VERIFIED", 403), { context });

      expect(view.kind).toBe("toast");
    }
  });
});

describe("server message rule for VALIDATION_FAILED", () => {
  it("shows a short, clean server message", () => {
    const cause = new ApiError({ code: "VALIDATION_FAILED", status: 400, message: "Title is required." });

    expect(describeError(cause).message).toBe("Title is required.");
  });

  it.each([
    ["braces", "Bad {value}"],
    ["brackets", "Bad [value]"],
    ["Error: prefix", "Error: bad input"],
    ["a stack line", "Bad input\n  at handler (file.ts:1)"],
    ["a line starting with at", "Bad input\nat handler"],
    ["200 characters or more", "x".repeat(200)],
    ["empty text", "   "],
  ])("falls back to the catalogue for %s", (_label, message) => {
    const cause = new ApiError({ code: "VALIDATION_FAILED", status: 400, message });
    const view = describeError(cause);

    expect(view.message).toBe(CATALOGUE.VALIDATION_FAILED.message);
    expect(view.message).not.toContain("{");
  });
});

describe("the server's free text is never shown for other codes", () => {
  it("uses the catalogue message for a known code", () => {
    const view = describeError(apiError("NOT_FOUND", 404, { message: "Row 42 missing from table" }), {
      context: "page",
    });

    expect(view.message).toBe(CATALOGUE.NOT_FOUND.message);
    expect(view.message).not.toContain("Row 42");
  });

  it("treats an unknown code as internal, whatever its text says", () => {
    const cause = apiError("SOMETHING_NEW", 418, { message: "raw {json}" });
    const view = describeError(cause);

    expect(view.message).toBe(GENERIC_ENTRY.message);
    expect(view.code).toBe("SOMETHING_NEW");
    expect(view.page).toBe(500);
  });

  it("an unknown code with a 503 status shows the 503 page", () => {
    const view = describeError(apiError("SOMETHING_NEW", 503), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(503);
  });
});

describe("client codes and network failures", () => {
  it("a network failure while online shows the 503 page", () => {
    setOnline(true);
    const view = describeError(apiError("UNAVAILABLE", 0), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(503);
    expect(view.title).toBe(CATALOGUE.UNAVAILABLE.title);
  });

  it("a network failure while offline shows the offline page", () => {
    setOnline(false);
    const view = describeError(apiError("UNAVAILABLE", 0), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe("offline");
    expect(view.title).toBe(CATALOGUE.offline.title);
    expect(view.code).toBe("UNAVAILABLE");
  });

  it("a network failure in a form is a toast, not a page", () => {
    setOnline(false);
    const view = describeError(apiError("UNAVAILABLE", 0), { context: "form" });

    expect(view.kind).toBe("toast");
    expect(view.page).toBe("offline");
  });

  it("a proxy timeout (504) shows the 504 page", () => {
    const view = describeError(apiError("UNAVAILABLE", 504), { context: "page" });

    expect(view.page).toBe(504);
  });

  it("a bad response shows the 500 page", () => {
    const view = describeError(apiError("BAD_RESPONSE", 200), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(500);
    expect(view.message).toBe(CATALOGUE.BAD_RESPONSE.message);
  });

  it("an HTTP fallback with a page status uses that page", () => {
    const view = describeError(apiError("HTTP_404", 404), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(404);
  });

  it("an HTTP fallback at 502 is fatal and shows the 502 page", () => {
    const view = describeError(apiError("HTTP_502", 502), { context: "action" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(502);
  });
});

describe("rate limiting", () => {
  it("keeps retryAfterSeconds and says how long to wait", () => {
    const view = describeError(apiError("RATE_LIMITED", 429, { retryAfter: 30 }), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(429);
    expect(view.retryAfterSeconds).toBe(30);
    expect(view.message).toBe("Wait 30 seconds and try again.");
  });

  it("leaves retryAfterSeconds unset when the server sent no Retry-After", () => {
    const view = describeError(apiError("RATE_LIMITED", 429), { context: "action" });

    expect(view.retryAfterSeconds).toBeUndefined();
    expect(view.message).toBe(CATALOGUE.RATE_LIMITED.message);
  });

  it("rounds a long wait to minutes", () => {
    const view = describeError(apiError("RATE_LIMITED", 429, { retryAfter: 90 }), { context: "action" });

    expect(view.message).toBe("Wait about 2 minutes and try again.");
  });
});

describe("the view carries what the caller needs", () => {
  it("passes the request id through", () => {
    const view = describeError(apiError("INTERNAL", 500, { requestId: "abc-123" }), { context: "page" });

    expect(view.requestId).toBe("abc-123");
  });

  it("the title and message never contain a code name or a number", () => {
    for (const entry of Object.values(CATALOGUE)) {
      expect(`${entry.title} ${entry.message}`).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
      expect(`${entry.title} ${entry.message}`).not.toMatch(/\d/);
    }
  });
});

describe("non-ApiError input", () => {
  it("a thrown TypeError is a generic toast in an action", () => {
    const view = describeError(new TypeError("cannot read x of undefined"), { context: "action" });

    expect(view.kind).toBe("toast");
    expect(view.message).toBe(GENERIC_ENTRY.message);
    expect(view.page).toBe(500);
    expect(view.message).not.toContain("cannot read");
  });

  it("a thrown TypeError is the 500 page in a page context", () => {
    const view = describeError(new TypeError("boom"), { context: "page" });

    expect(view.kind).toBe("page");
    expect(view.page).toBe(500);
  });

  it("a plain string is a generic toast", () => {
    const view = describeError("something failed");

    expect(view.kind).toBe("toast");
    expect(view.message).toBe(GENERIC_ENTRY.message);
  });

  it.each([null, undefined, 42, { code: "NOT_FOUND" }])("never throws for %j", (cause) => {
    expect(() => describeError(cause)).not.toThrow();
    expect(describeError(cause).page).toBe(500);
  });

  it("never throws when reading the error throws", () => {
    const cause = apiError("NOT_FOUND", 404);
    Object.defineProperty(cause, "status", {
      get() {
        throw new Error("boom");
      },
    });

    expect(() => describeError(cause, { context: "page" })).not.toThrow();
    expect(describeError(cause, { context: "page" }).page).toBe(500);
  });
});

describe("compatibility helpers", () => {
  it("messageFor returns the server text for a clean validation error", () => {
    const cause = new ApiError({ code: "VALIDATION_FAILED", status: 400, message: "Name is taken." });

    expect(messageFor(cause)).toBe("Name is taken.");
  });

  it("messageFor returns the generic text for a non-ApiError", () => {
    expect(messageFor(new Error("x"))).toBe(GENERIC_ENTRY.message);
  });

  it("validationField returns the matching field from the list", () => {
    const cause = apiError("VALIDATION_FAILED", 400, { details: [{ path: "name" }] });

    expect(validationField(cause, ["name", "slug"] as const)).toBe("name");
  });

  it("validationField ignores other codes", () => {
    const cause = apiError("NOT_FOUND", 404, { details: [{ path: "name" }] });

    expect(validationField(cause, ["name"])).toBeUndefined();
  });
});
