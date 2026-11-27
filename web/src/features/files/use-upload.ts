"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type ErrorView } from "@/lib/errors";
import { withMessage } from "@/features/data/errors";
import { uploadFile, validateFile, type FileItem } from "./client";

export type UploadEntry = { id: string; file: File; status: "queued" | "uploading" | "done" | "error" | "cancelled"; progress: number; error?: string; result?: FileItem };

/** The message shown on the file itself. Problems with the file are field-level; the rest is a toast. */
function fileMessage(error: unknown): { message?: string; toast?: ErrorView } {
  const view = describeError(error, { context: "action" });
  if (view.code === "PAYLOAD_TOO_LARGE") return { message: "That file is too big." };
  if (view.code === "UNSUPPORTED_MEDIA_TYPE") return { message: "That file type isn't supported." };
  if (view.code === "LIMIT_REACHED") {
    return {
      message: "Not uploaded.",
      toast: withMessage(view, "You've reached your storage limit. Delete a file to upload another."),
    };
  }
  return { message: view.message };
}

/**
 * Uploads run three at a time. `onFailure` gets the errors that are a toast (storage limit, and any
 * error the file can't explain on its own). The file's own problems stay on its row.
 */
export function useUpload(onComplete?: (file: FileItem) => void, onFailure?: (view: ErrorView) => void) {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const callback = useRef(onComplete);
  callback.current = onComplete;
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const add = useCallback((files: File[]) => {
    setEntries((old) => [...old, ...files.map((file) => {
      const error = validateFile(file);
      return { id: crypto.randomUUID(), file, status: error ? "error" as const : "queued" as const, progress: 0, error: error ?? undefined };
    })]);
  }, []);
  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setEntries((old) => old.map((entry) => entry.id === id && (entry.status === "queued" || entry.status === "uploading") ? { ...entry, status: "cancelled" } : entry));
  }, []);
  useEffect(() => {
    const available = 3 - controllers.current.size;
    for (const entry of entries.filter((item) => item.status === "queued").slice(0, available)) {
      const controller = new AbortController();
      controllers.current.set(entry.id, controller);
      setEntries((old) => old.map((item) => item.id === entry.id ? { ...item, status: "uploading" } : item));
      void uploadFile(entry.file, (progress) => setEntries((old) => old.map((item) => item.id === entry.id ? { ...item, progress } : item)), controller.signal).then((result) => {
        setEntries((old) => old.map((item) => item.id === entry.id ? { ...item, status: "done", result, progress: 100 } : item));
        callback.current?.(result);
      }).catch((error: unknown) => {
        if (controller.signal.aborted) {
          setEntries((old) => old.map((item) => item.id === entry.id ? { ...item, status: "cancelled" } : item));
          return;
        }
        const shown = fileMessage(error);
        if (shown.toast) failure.current?.(shown.toast);
        setEntries((old) => old.map((item) => item.id === entry.id ? { ...item, status: "error", error: shown.message } : item));
      }).finally(() => {
        controllers.current.delete(entry.id);
        setEntries((old) => [...old]);
      });
    }
  }, [entries]);
  useEffect(() => {
    const active = controllers.current;
    return () => active.forEach((controller) => controller.abort());
  }, []);
  return { entries, add, cancel };
}
