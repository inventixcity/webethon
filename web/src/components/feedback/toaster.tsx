"use client";

import { useMemo, type ReactNode } from "react";
import { ToastStack, ToastStoreProvider, useToast as useStackToast } from "@/components/effects/toast-stack";
import type { ErrorView } from "@/lib/errors/types";

/** A button shown inside a toast. Clicking it runs `onClick`, then the toast closes. */
export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = { action?: ToastAction };

export type ToastApi = {
  /** Shows an error for 8 seconds. A string is shown as the message. */
  error: (view: ErrorView | string, options?: ToastOptions) => void;
  /** Shows a confirmation for 4 seconds. */
  success: (message: string, options?: ToastOptions) => void;
  /** Shows a neutral note for 4 seconds. */
  info: (message: string, options?: ToastOptions) => void;
};

const ERROR_MS = 8000;
const NOTICE_MS = 4000;

/** Holds the toast state. Wrap the app in it once; mount <Toaster /> where the stack should draw. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <ToastStoreProvider>{children}</ToastStoreProvider>;
}

/** Shows toasts. Must be used inside <ToastProvider>. The stack is the toast-stack component. */
export function useToast(): ToastApi {
  const stack = useStackToast();
  const show = stack.show;

  return useMemo<ToastApi>(
    () => ({
      error: (view, options) => {
        const action = options?.action;
        if (typeof view === "string") {
          show({ tone: "error", title: view, action, duration: ERROR_MS });
          return;
        }
        show({
          tone: "error",
          title: view.title,
          body: view.message,
          requestId: view.requestId,
          action,
          duration: ERROR_MS,
        });
      },
      success: (message, options) =>
        show({ tone: "success", title: message, action: options?.action, duration: NOTICE_MS }),
      info: (message, options) => show({ tone: "info", title: message, action: options?.action, duration: NOTICE_MS }),
    }),
    [show],
  );
}

/**
 * Renders the toast stack (toast-stack visuals). Mount it once, inside <ToastProvider>.
 * Errors are role="alert" (assertive); success, info and loading are role="status" (polite).
 */
export function Toaster({ className }: { className?: string }) {
  return <ToastStack className={className} />;
}
