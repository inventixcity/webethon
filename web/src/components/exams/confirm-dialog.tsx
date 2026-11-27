"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A modal confirmation built on the native dialog element, so focus is trapped and Escape closes it.
 * The parent owns `open`. Cancelling (Escape, or the Cancel button) calls `onCancel`.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending = false,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      className="m-auto w-[min(560px,calc(100vw-2rem))] border border-ink bg-paper p-0 text-ink backdrop:bg-ink/40"
    >
      <div className="grid gap-6 p-6 md:p-8">
        <h2 id={titleId} className="text-2xl leading-tight font-medium tracking-[-0.02em]">
          {title}
        </h2>
        <div className="grid gap-3 text-ink-soft">{children}</div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant={destructive ? "danger" : "primary"} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
