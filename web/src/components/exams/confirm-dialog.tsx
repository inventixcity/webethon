"use client";

import type { ReactNode } from "react";
import { ConfirmDialog as SharedConfirmDialog } from "@/components/ui/dialog";

/** The exam screens' confirmation. A thin adapter over the shared accessible ConfirmDialog. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending = false,
  destructive = false,
  eyebrow,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  destructive?: boolean;
  eyebrow?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <SharedConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      tone={destructive ? "danger" : "primary"}
      busy={pending}
      eyebrow={eyebrow}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {children}
    </SharedConfirmDialog>
  );
}
