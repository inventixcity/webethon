"use client";

import { X } from "lucide-react";
import { createContext, useContext, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Dialog } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Dialogs render into the workspace root, so the workspace theme and contrast settings reach them.
 * Portals to document.body would lose the data-theme override.
 */
export const WorkspaceRootContext = createContext<HTMLElement | null>(null);

export function useWorkspaceRoot(): HTMLElement | null {
  return useContext(WorkspaceRootContext);
}

const CLOSE_CLASS =
  "flex size-12 shrink-0 cursor-pointer items-center justify-center text-ink-muted transition-colors duration-(--duration-base) hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";

type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  side?: "right" | "left" | "bottom";
  /** Resizable drawers show a drag handle on their inner edge. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange?: (width: number) => void;
  children: ReactNode;
  className?: string;
};

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  side = "right",
  width,
  minWidth = 320,
  maxWidth = 960,
  onWidthChange,
  children,
  className,
}: DrawerProps) {
  const root = useWorkspaceRoot();
  const contentRef = useRef<HTMLDivElement>(null);
  const bottom = side === "bottom";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={root ?? undefined}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/35" />
        <Dialog.Content
          ref={contentRef}
          data-side={side}
          style={!bottom && width !== undefined ? { width: `min(${width}px, 100vw)` } : undefined}
          className={cn(
            "fixed z-50 flex flex-col bg-paper text-ink focus:outline-none",
            bottom
              ? "inset-x-0 bottom-0 max-h-[85dvh] border-t border-ink ws-drawer-bottom"
              : side === "left"
                ? "inset-y-0 left-0 w-[min(28rem,100vw)] border-r border-ink ws-drawer-left"
                : "inset-y-0 right-0 w-[min(28rem,100vw)] border-l border-ink ws-drawer-right",
            className,
          )}
        >
          {!bottom && onWidthChange !== undefined && width !== undefined && (
            <ResizeHandle
              width={width}
              minWidth={minWidth}
              maxWidth={maxWidth}
              onWidthChange={onWidthChange}
              contentRef={contentRef}
            />
          )}
          <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="font-sans text-xl font-semibold tracking-[-0.02em]">{title}</Dialog.Title>
              {description !== undefined && (
                <Dialog.Description className="mt-1 font-sans text-sm text-ink-soft">{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close aria-label="Close" className={CLOSE_CLASS}>
              <X className="size-5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A centred dialog for confirmations and summaries. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const root = useWorkspaceRoot();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={root ?? undefined}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/35" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[88dvh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col border border-ink bg-paper text-ink focus:outline-none ws-modal",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="font-sans text-xl font-semibold tracking-[-0.02em]">{title}</Dialog.Title>
              {description !== undefined && (
                <Dialog.Description className="mt-1 font-sans text-sm text-ink-soft">{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close aria-label="Close" className={CLOSE_CLASS}>
              <X className="size-5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Drag or arrow-key resize of the drawer's inner edge (a focusable separator). */
function ResizeHandle({
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  contentRef,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const clamp = (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value)));

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = contentRef.current?.getBoundingClientRect().width ?? width;
    const move = (e: globalThis.PointerEvent) => onWidthChange(clamp(startWidth + (startX - e.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clamp(width + step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clamp(width - step));
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize drawer"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none hover:bg-rule focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-vermilion hidden sm:block"
    />
  );
}
