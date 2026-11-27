"use client";

import { X } from "lucide-react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Modal surfaces, built on Radix so focus is trapped, Escape closes, focus returns to the opener, the page behind
 * is inert and aria-modal is set. Square, hairline, no shadow; the scrim dims without inverting in dark mode.
 */

const overlayClass =
  "fixed inset-0 z-50 grid overflow-y-auto bg-scrim p-4 animate-fade-in motion-reduce:animate-none md:p-8";

const sizeClass = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" } as const;

function DialogEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
      <span aria-hidden="true" className="size-1.5 bg-vermilion" />
      {children}
    </p>
  );
}

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Mono caption above the title, for example "Confirm / Publish". */
  eyebrow?: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  size?: keyof typeof sizeClass;
  /** When false, Escape and clicks outside do nothing (while a request is in flight, for example). */
  dismissible?: boolean;
  className?: string;
};

/** A centred modal for forms and details. */
export function Dialog({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  className,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next || dismissible ? onOpenChange(next) : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClass}>
          <DialogPrimitive.Content
            className={cn(
              "relative m-auto grid w-full gap-6 border border-ink bg-paper p-6 text-ink animate-rise-in focus-visible:outline-none motion-reduce:animate-none md:p-8",
              sizeClass[size],
              className,
            )}
          >
            <div className="grid gap-3 pr-10">
              {eyebrow ? <DialogEyebrow>{eyebrow}</DialogEyebrow> : null}
              <DialogPrimitive.Title className="text-2xl leading-tight font-medium tracking-[-0.02em] break-words md:text-3xl">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-base text-ink-soft">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</DialogPrimitive.Description>
              )}
            </div>
            {children}
            {footer ? <div className="flex flex-wrap justify-end gap-3 border-t border-rule pt-6">{footer}</div> : null}
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                disabled={!dismissible}
                className="absolute top-3 right-3 size-10"
              >
                <X aria-hidden="true" className="size-5" />
              </Button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /** What will happen, in plain words. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger: the action removes, revokes or cannot be undone. */
  tone?: "primary" | "danger";
  busy?: boolean;
  eyebrow?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Asks before a consequential action. Focus starts on Cancel, so a stray Enter never confirms. Escape cancels
 * unless the action is already running.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  busy = false,
  eyebrow,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <AlertPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlayClass}>
          <AlertPrimitive.Content
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            className="relative m-auto grid w-full max-w-lg gap-6 border border-ink bg-paper p-6 text-ink animate-rise-in focus-visible:outline-none motion-reduce:animate-none md:p-8"
          >
            {tone === "danger" ? (
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-vermilion-deep" />
            ) : null}
            <div className="grid gap-3">
              <DialogEyebrow>{eyebrow ?? (tone === "danger" ? "Confirm / Destructive" : "Confirm")}</DialogEyebrow>
              <AlertPrimitive.Title className="text-2xl leading-tight font-medium tracking-[-0.02em] break-words md:text-3xl">
                {title}
              </AlertPrimitive.Title>
            </div>
            <AlertPrimitive.Description asChild>
              <div className="grid gap-3 text-base text-ink-soft">{children}</div>
            </AlertPrimitive.Description>
            <div className="flex flex-wrap justify-end gap-3 border-t border-rule pt-6">
              <AlertPrimitive.Cancel asChild>
                <Button variant="secondary" disabled={busy}>
                  {cancelLabel}
                </Button>
              </AlertPrimitive.Cancel>
              <Button
                variant={tone === "danger" ? "danger" : "primary"}
                loading={busy}
                onClick={(event) => {
                  event.preventDefault();
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertPrimitive.Content>
        </AlertPrimitive.Overlay>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  eyebrow?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/** A full-height panel from the right edge, for the details of one row (an attempt, an account). */
export function Sheet({ open, onOpenChange, title, eyebrow, description, children, footer, className }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim animate-fade-in motion-reduce:animate-none" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-ink bg-paper text-ink animate-sheet-in focus-visible:outline-none motion-reduce:animate-none",
            className,
          )}
        >
          <div className="grid gap-3 border-b border-ink px-5 pt-6 pb-5 pr-16 md:px-8">
            {eyebrow ? <DialogEyebrow>{eyebrow}</DialogEyebrow> : null}
            <DialogPrimitive.Title className="text-[clamp(1.75rem,4vw,2.5rem)] leading-none font-medium tracking-[-0.03em] break-words">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description asChild>
                <div className="text-sm text-ink-soft">{description}</div>
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">Details</DialogPrimitive.Description>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-3 border-t border-rule px-5 py-4 md:px-8">{footer}</div> : null}
          <DialogPrimitive.Close asChild>
            <Button variant="secondary" size="icon" aria-label="Close panel" className="absolute top-4 right-4 size-10">
              <X aria-hidden="true" className="size-5" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
