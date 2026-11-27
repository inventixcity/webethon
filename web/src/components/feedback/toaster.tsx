"use client";

import { Check, Copy, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ErrorView } from "@/lib/errors/types";
import { cn } from "@/lib/utils";

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

type ToastTone = "error" | "success" | "info";

type ToastItem = {
  id: number;
  tone: ToastTone;
  title?: string;
  message: string;
  requestId?: string;
  action?: ToastAction;
  closing: boolean;
};

const ERROR_MS = 8000;
const NOTICE_MS = 4000;
const EXIT_MS = 200;
const MAX_TOASTS = 4;

type ToastStore = { api: ToastApi; toasts: ToastItem[]; dismiss: (id: number) => void };

const ToastContext = createContext<ToastStore | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /** Plays the exit transition, then removes the toast. */
  const dismiss = useCallback(
    (id: number) => {
      const pending = timers.current.get(id);
      if (pending !== undefined) clearTimeout(pending);
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)));
      timers.current.set(
        id,
        setTimeout(() => remove(id), EXIT_MS),
      );
    },
    [remove],
  );

  const push = useCallback(
    (item: Omit<ToastItem, "id" | "closing">, ttl: number) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [...current, { ...item, id, closing: false }].slice(-MAX_TOASTS));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ttl),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      error: (view, options) =>
        typeof view === "string"
          ? push({ tone: "error", message: view, action: options?.action }, ERROR_MS)
          : push(
              {
                tone: "error",
                title: view.title,
                message: view.message,
                requestId: view.requestId,
                action: options?.action,
              },
              ERROR_MS,
            ),
      success: (message, options) => push({ tone: "success", message, action: options?.action }, NOTICE_MS),
      info: (message, options) => push({ tone: "info", message, action: options?.action }, NOTICE_MS),
    }),
    [push],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const store = useMemo<ToastStore>(() => ({ api, toasts, dismiss }), [api, toasts, dismiss]);

  return <ToastContext.Provider value={store}>{children}</ToastContext.Provider>;
}

function useToastStore(): ToastStore {
  const store = useContext(ToastContext);
  if (store === null) throw new Error("useToast must be used inside <ToastProvider>.");
  return store;
}

/** Shows toasts. Must be used inside <ToastProvider>. */
export function useToast(): ToastApi {
  return useToastStore().api;
}

/**
 * Renders the toast stack. Mount it once, inside <ToastProvider>.
 * The region is always present, so screen readers hear each new toast. Errors use role="alert".
 */
export function Toaster({ className }: { className?: string }) {
  const { toasts, dismiss } = useToastStore();

  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96",
        className,
      )}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

const LABELS: Record<ToastTone, string> = {
  error: "Error",
  success: "Done",
  info: "Note",
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  // The first frame renders hidden, so the card can fade and slide in.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const visible = entered && !toast.closing;
  const isError = toast.tone === "error";
  const action = toast.action;

  return (
    <div
      role={isError ? "alert" : undefined}
      data-tone={toast.tone}
      className={cn(
        "pointer-events-auto relative border bg-paper-raised text-ink transition-[opacity,translate] duration-300 ease-editorial motion-reduce:transition-none",
        isError ? "border-vermilion-deep" : "border-ink",
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-mono text-[11px] tracking-[0.14em] uppercase",
              isError ? "text-vermilion-deep" : "text-ink-muted",
            )}
          >
            {LABELS[toast.tone]}
          </p>
          {toast.title !== undefined && <p className="mt-1 font-sans font-medium text-ink">{toast.title}</p>}
          <p className={cn("font-sans text-sm text-ink-soft", toast.title !== undefined && "mt-1")}>{toast.message}</p>
          {toast.requestId !== undefined && <RequestReference id={toast.requestId} />}
          {action !== undefined && (
            <button
              type="button"
              onClick={() => {
                action.onClick();
                onDismiss();
              }}
              className={cn(
                "mt-3 cursor-pointer border px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase transition-colors duration-200 motion-reduce:transition-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion",
                isError
                  ? "border-vermilion-deep text-vermilion-deep hover:bg-vermilion-deep hover:text-paper"
                  : "border-ink text-ink hover:bg-ink hover:text-paper",
              )}
            >
              {action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 flex size-8 shrink-0 cursor-pointer items-center justify-center text-ink-muted transition-colors duration-300 hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The request id to quote to support, with a copy button. */
function RequestReference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
      <span className="min-w-0 truncate">Reference: {id}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Reference copied" : "Copy reference"}
        className="flex shrink-0 cursor-pointer items-center gap-1 uppercase tracking-[0.12em] hover:text-ink"
      >
        {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
