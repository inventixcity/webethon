/**
 * Import and export of records through the same-origin /api/v1 proxy. Errors are ApiError, like every other
 * client. The file and its rows are never logged: they hold the user's data.
 */
import { ApiError } from "@/lib/api/client";

export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_EXPORT_ROWS = 50000;

export type ExportFormat = "csv" | "json";

export type FailedRow = {
  row: number;
  errors: { path: string; message: string }[];
};

export type ImportReport = {
  created: number;
  failed: FailedRow[];
};

const ACCEPTED_EXTENSIONS = ["csv", "json"] as const;

/** A problem with the chosen file, or null when it can be uploaded. Checked before any request is sent. */
export function checkImportFile(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return "Choose a CSV or JSON file.";
  }
  if (file.size > MAX_IMPORT_BYTES) return "That file is over 4 MB. Split it into smaller files.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

/**
 * The href for an export. The server streams the file with its own Content-Disposition, so the browser
 * downloads it from a plain link.
 */
export function exportHref(entity: string, format: ExportFormat, teamId?: string | null): string {
  const params = new URLSearchParams({ format });
  if (teamId) {
    params.set("scope", "team");
    params.set("teamId", teamId);
  } else {
    params.set("scope", "mine");
  }
  return `/api/v1/entities/${encodeURIComponent(entity)}/export?${params}`;
}

/**
 * The response header that names the row cap when the server limits an export. The proxy forwards only the
 * headers it lists, so this name has to be on that list for the cap note to appear.
 */
export const EXPORT_ROW_LIMIT_HEADER = "x-export-row-limit";

export type ExportFile = {
  blob: Blob;
  /** From Content-Disposition, or `<entity>.<format>` when the server sends no usable name. */
  filename: string;
  /** The cap the server sent in EXPORT_ROW_LIMIT_HEADER, or undefined when it sent none. */
  rowLimit: number | undefined;
};

/**
 * Downloads an export through fetch instead of a plain link. A plain link would open a JSON error in a new tab
 * (for example the 422 for a collection over the row cap). Every failure is an ApiError, like the other calls.
 */
export async function downloadExport(entity: string, format: ExportFormat, teamId?: string | null): Promise<ExportFile> {
  let response: Response;
  try {
    response = await fetch(exportHref(entity, format, teamId), {
      method: "GET",
      headers: { accept: format === "csv" ? "text/csv, application/json" : "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "We can't reach the service right now. Check your connection and try again." });
  }

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }
      | null;
    throw new ApiError({
      code: json?.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      message: json?.error?.message ?? "Could not export the file.",
      details: json?.error?.details,
      requestId: json?.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "The download was interrupted. Try again." });
  }

  return {
    blob,
    filename: filenameFrom(response.headers.get("content-disposition"), `${entity}.${format}`),
    rowLimit: parseRowLimit(response.headers.get(EXPORT_ROW_LIMIT_HEADER)),
  };
}

/**
 * Validates a file against the entity. dryRun=true creates nothing and reports what would happen.
 * The server reports unknown columns and bad values as row errors in `failed`.
 */
export async function importRecords(
  entity: string,
  file: File,
  options: { dryRun: boolean; atomic: boolean },
): Promise<ImportReport> {
  const params = new URLSearchParams({
    dryRun: String(options.dryRun),
    atomic: String(options.atomic),
  });
  const body = new FormData();
  body.append("file", file, file.name);

  let response: Response;
  try {
    response = await fetch(`/api/v1/entities/${encodeURIComponent(entity)}/import?${params}`, {
      method: "POST",
      body,
      // No Content-Type header: the browser adds the multipart boundary itself.
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "We can't reach the service right now. Check your connection and try again." });
  }

  const json = (await response.json().catch(() => null)) as
    | { data?: unknown; error?: { code?: string; message?: string; details?: unknown; requestId?: string } }
    | null;

  if (!response.ok) {
    throw new ApiError({
      code: json?.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      message: json?.error?.message ?? "Could not import the file.",
      details: json?.error?.details,
      requestId: json?.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    });
  }

  if (!isImportReport(json?.data)) {
    throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The server returned an invalid response." });
  }
  return normalise(json.data);
}

function isImportReport(value: unknown): value is { created: unknown; failed: unknown } {
  return typeof value === "object" && value !== null && "created" in value && "failed" in value;
}

function normalise(value: { created: unknown; failed: unknown }): ImportReport {
  const created = Array.isArray(value.created) ? value.created.length : Number(value.created) || 0;
  const failed: FailedRow[] = Array.isArray(value.failed)
    ? value.failed.flatMap((item): FailedRow[] => {
        if (typeof item !== "object" || item === null) return [];
        const row = Number((item as { row?: unknown }).row);
        const errors = Array.isArray((item as { errors?: unknown }).errors) ? (item as { errors: unknown[] }).errors : [];
        return [
          {
            row: Number.isFinite(row) ? row : 0,
            errors: errors.flatMap((error) => {
              if (typeof error !== "object" || error === null) return [];
              const { path, message } = error as { path?: unknown; message?: unknown };
              return [{ path: typeof path === "string" ? path : "", message: typeof message === "string" ? message : "" }];
            }),
          },
        ];
      })
    : [];
  return { created, failed };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function parseRowLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

/**
 * The filename from Content-Disposition: RFC 5987 `filename*` first, then `filename`. The fallback is used when
 * neither is present or the name is unusable.
 */
function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded[1].trim()), fallback);
    } catch {
      // A malformed percent-encoding: fall through to the plain filename.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  return plain ? safeFilename((plain[1] ?? plain[2] ?? "").trim(), fallback) : fallback;
}

/** Keeps only the last path part and drops control characters, so a name can't point at a folder. */
function safeFilename(name: string, fallback: string): string {
  const printable = Array.from(name.split(/[\\/]/).pop() ?? "")
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return printable === "" || printable === "." || printable === ".." ? fallback : printable;
}
