"use client";
import { useRef, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { useUpload } from "@/features/files/use-upload";
import type { FileItem } from "@/features/files/client";
import { Button } from "@/components/ui/button";

export function FileDrop({ onUpload, className = "" }: { onUpload?: (file: FileItem) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const toast = useToast();
  const upload = useUpload(onUpload, (view) => toast.error(view));
  return (
    <div className={className} onPaste={(event) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length) {
        event.preventDefault();
        upload.add(files);
      }
    }}>
      <div className={`border border-dashed p-6 ${dragging ? "border-vermilion bg-paper-sunk" : "border-ink bg-paper-raised"}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); upload.add(Array.from(event.dataTransfer.files)); }}>
        <input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,image/png,image/jpeg,image/webp,image/gif,application/pdf" className="sr-only" tabIndex={-1} onChange={(event) => {
          upload.add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <p className="font-mono text-xs uppercase tracking-widest">Drop files or paste here</p>
        <p className="mt-2 text-sm text-ink-muted">PNG, JPEG, WebP, GIF or PDF / 4 MiB maximum</p>
        <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => input.current?.click()}>Choose files</Button>
      </div>
      <ul className="divide-y divide-rule" aria-label="Uploads">
        {upload.entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-4 py-4">
            {entry.result?.contentType.startsWith("image/") && <img src={entry.result.url} alt="" className="h-16 w-16 shrink-0 object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm">{entry.file.name}</p>
              {(entry.status === "uploading" || entry.status === "queued") && <progress className="mt-2 h-2 w-full accent-ink" max={100} value={entry.progress} aria-label={`Upload progress for ${entry.file.name}`} />}
              <p className="mt-1 break-words font-mono text-xs text-ink-muted">{entry.status === "error" ? <span role="alert" className="text-vermilion-deep">{entry.error ?? "Not uploaded."}</span> : entry.status}</p>
            </div>
            {(entry.status === "uploading" || entry.status === "queued") && <Button type="button" variant="link" className="overflow-visible" onClick={() => upload.cancel(entry.id)} aria-label={`Cancel ${entry.file.name}`}>Cancel</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
