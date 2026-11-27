"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Toasts that live inside the workspace root, so they take the workspace theme and contrast, and stay visible
 * when the exam is fullscreen. `announcement` toasts are assertive (an examiner instruction may change what the
 * candidate must do); everything else is polite. Errors stay until dismissed or replaced.
 */
type Tone = "info" | "success" | "error" | "announcement";
type Toast = { id: number; tone: Tone; title: string; message: string; key?: string };
type ToastInput = { title?: string; message: string; key?: string };

type WsToastApi = {
  info: (input: ToastInput) => void;
  success: (input: ToastInput) => void;
  error: (input: ToastInput) => void;
  announcement: (input: ToastInput) => void;
  dismissKey: (key: string) => void;
};

const TTL: Record<Tone, number | null> = { info: 6000, success: 6000, error: null, announcement: 15000 };
const DEFAULT_TITLE: Record<Tone, string> = { info: "Note", success: "Done", error: "Needs attention", announcement: "From the examiner" };
const MAX = 3;

const Context = createContext<{ api: WsToastApi; toasts: Toast[]; dismiss: (id: number) => void } | null>(null);

export function WsToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, input: ToastInput) => {
      nextId.current += 1;
      const id = nextId.current;
      const toast: Toast = { id, tone, title: input.title ?? DEFAULT_TITLE[tone], message: input.message, key: input.key };
      // A keyed toast replaces the previous one with the same key, so repeated states never stack.
      setToasts((current) => [...current.filter((item) => !input.key || item.key !== input.key), toast].slice(-MAX));
      const ttl = TTL[tone];
      if (ttl !== null) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    },
    [dismiss],
  );

  const api = useMemo<WsToastApi>(
    () => ({
      info: (input) => push("info", input),
      success: (input) => push("success", input),
      error: (input) => push("error", input),
      announcement: (input) => push("announcement", input),
      dismissKey: (key) => setToasts((current) => current.filter((toast) => toast.key !== key)),
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

  const value = useMemo(() => ({ api, toasts, dismiss }), [api, toasts, dismiss]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWsToast(): WsToastApi {
  const value = useContext(Context);
  if (value === null) throw new Error("useWsToast must be used inside <WsToastProvider>.");
  return value.api;
}

/** Mount once inside the workspace root. Both regions are always present, so screen readers hear new toasts. */
export function WsToaster() {
  const value = useContext(Context);
  if (value === null) return null;
  const { toasts, dismiss } = value;
  const polite = toasts.filter((toast) => toast.tone !== "announcement" && toast.tone !== "error");
  const urgent = toasts.filter((toast) => toast.tone === "announcement" || toast.tone === "error");
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-stretch gap-2 sm:left-auto sm:w-[24rem]">
      <div aria-live="assertive" aria-atomic="false" className="flex flex-col gap-2">
        {urgent.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
      <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {polite.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const strong = toast.tone === "error" || toast.tone === "announcement";
  return (
    <div
      data-tone={toast.tone}
      className={cn(
        "ws-toast pointer-events-auto flex items-start gap-3 border p-4",
        strong ? "border-ink bg-ink text-paper" : "border-ink bg-paper-raised text-ink",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn("font-mono text-[11px] tracking-[0.14em] uppercase", strong ? "text-paper" : "text-ink-muted")}>
          {toast.title}
        </p>
        <p className={cn("mt-1 font-sans text-sm whitespace-pre-wrap", strong ? "text-paper" : "text-ink-soft")}>
          {toast.message}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss: ${toast.title}`}
        className={cn(
          "-mt-1 -mr-1 grid size-10 shrink-0 cursor-pointer place-items-center transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion",
          strong ? "text-paper hover:bg-paper/15" : "text-ink-muted hover:text-ink",
        )}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
