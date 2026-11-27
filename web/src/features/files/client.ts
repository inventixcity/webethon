import { api, ApiError } from "@/lib/api/client";

export type FileItem = {
  id: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  visibility: "private" | "public";
};

export const MAX_FILE_SIZE = 4 * 1024 * 1024;
const types: Record<string, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  pdf: ["application/pdf"],
};

export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) return "That file is too big.";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!types[extension] || !types[extension].includes(file.type.toLowerCase())) {
    return "That file type isn't supported.";
  }
  return null;
}

export function uploadFile(file: File, onProgress: (progress: number) => void, signal: AbortSignal): Promise<FileItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("POST", "/api/v1/files");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      const body = xhr.response as { data?: FileItem; error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.data) resolve({ ...body.data, visibility: body.data.visibility ?? "private" });
      else reject(new ApiError({ code: body?.error?.code ?? `HTTP_${xhr.status}`, status: xhr.status, message: body?.error?.message ?? "Could not upload the file.", details: body?.error?.details, requestId: body?.error?.requestId }));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new ApiError({ code: "UNAVAILABLE", status: 0, message: "Could not reach the service." }));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const data = new FormData();
    data.append("file", file);
    xhr.send(data);
  });
}

export async function listFiles(cursor?: string): Promise<{ data: FileItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "24" });
  if (cursor) params.set("cursor", cursor);
  let response: Response;
  try {
    response = await fetch(`/api/v1/files?${params}`, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "Could not reach the service." });
  }
  const body = await response.json().catch(() => null) as { data?: FileItem[]; meta?: { nextCursor?: string | null }; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiError({ code: body?.error?.code ?? `HTTP_${response.status}`, status: response.status, message: body?.error?.message ?? "Could not load files." });
  if (!Array.isArray(body?.data)) throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "Invalid file list." });
  return { data: body.data, nextCursor: body.meta?.nextCursor ?? null };
}

export function deleteFile(id: string) {
  return api<void>(`/files/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setFileVisibility(id: string, visibility: "private" | "public") {
  return api<FileItem>(`/files/${encodeURIComponent(id)}`, { method: "PATCH", body: { visibility } });
}
