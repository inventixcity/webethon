"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A drop zone with a file input behind it. Keyboard users reach the same button as mouse users.
 * Checks the size before reading; the caller checks the type and reads the text.
 */
export function FilePicker({
  accept,
  maxBytes,
  onFile,
  onReject,
  hint,
  className,
}: {
  accept: string;
  maxBytes: number;
  onFile: (file: File) => void;
  onReject: (message: string) => void;
  hint: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function take(list: FileList | null | undefined) {
    const file = list?.[0];
    if (!file) return;
    if (file.size > maxBytes) {
      onReject(`That file is larger than ${Math.round(maxBytes / 1024)} KB. Split it into smaller files.`);
      return;
    }
    onFile(file);
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        take(event.dataTransfer.files);
      }}
      className={cn(
        "grid gap-4 border border-dashed p-6 transition-colors duration-(--duration-base) sm:p-10",
        dragging ? "border-vermilion-deep bg-paper-sunk" : "border-ink bg-paper-raised",
        className,
      )}
    >
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">{hint}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="button" variant="secondary" onClick={() => input.current?.click()}>
          Choose a file
        </Button>
        <span className="font-sans text-sm text-ink-soft">or drop it here</span>
      </div>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
