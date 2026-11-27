"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A modal confirmation. Focus starts on Cancel, so a stray Enter never confirms. Escape cancels unless busy.
 * Shared by the monitor, results and admin screens.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Kept in a ref so a parent re-render does not move focus back to Cancel.
  const cancelHandler = useRef({ onCancel, busy });
  useEffect(() => {
    cancelHandler.current = { onCancel, busy };
  });

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cancelHandler.current.busy) cancelHandler.current.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-4">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="grid w-full max-w-md gap-5 border border-ink bg-paper p-6 text-ink"
      >
        <h2 id={titleId} className="text-2xl leading-none font-semibold tracking-tight">
          {title}
        </h2>
        <div id={descriptionId} className="grid gap-3 text-sm text-ink-soft">
          {children}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button ref={cancelRef} variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} size="sm" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
