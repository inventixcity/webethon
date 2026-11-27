"use client";

import type { ReactNode } from "react";
import { ConfirmDialog as SharedConfirmDialog } from "@/components/ui/dialog";

/**
 * A modal confirmation for the monitor, results and admin screens. Focus starts on Cancel, so a stray Enter never
 * confirms; Escape cancels unless busy. Adapter over the shared ConfirmDialog.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  busy = false,
  eyebrow,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  eyebrow?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <SharedConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      tone={tone}
      busy={busy}
      eyebrow={eyebrow}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {children}
    </SharedConfirmDialog>
  );
}
