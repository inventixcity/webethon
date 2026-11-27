"use client";

import { useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { downloadExport, MAX_EXPORT_ROWS, type ExportFormat } from "@/features/transfer/client";

/**
 * CSV and JSON download buttons for a collection. The download runs through fetch, so a failure (for example a
 * collection over the row cap) becomes a toast, never a raw JSON response in a new tab. The cap note appears only
 * when the server says it limited the export.
 */
export function ExportButtons({ entity, teamId }: { entity: string; teamId?: string | null }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  // Keyed by collection and team, so a note from one collection never shows on another.
  const [cappedFor, setCappedFor] = useState<string | null>(null);
  const toast = useToast();
  const key = `${entity}:${teamId ?? ""}`;

  async function download(format: ExportFormat) {
    if (busy !== null) return;
    setBusy(format);
    try {
      const file = await downloadExport(entity, format, teamId);
      saveBlob(file.blob, file.filename);
      setCappedFor(file.rowLimit === MAX_EXPORT_ROWS ? key : null);
    } catch (error) {
      // Fatal codes (sign-in, forbidden, server errors) are toasts here too: a download button is not a page.
      toast.error(describeError(error, { context: "action" }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" loading={busy === "csv"} disabled={busy !== null} onClick={() => void download("csv")}>
          Export CSV
        </Button>
        <Button variant="secondary" loading={busy === "json"} disabled={busy !== null} onClick={() => void download("json")}>
          Export JSON
        </Button>
      </div>
      {cappedFor === key && <p role="status" className="text-xs text-ink-muted">Exports stop at 50,000 rows.</p>}
    </div>
  );
}

/** Saves a blob through a temporary object URL. The URL is revoked a moment later, once the click has started the download. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
