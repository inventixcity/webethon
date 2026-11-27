"use client";

import { AlertTriangle, Check, Copy, Info, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error" | "loading";

export type ToastInput = {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** The request id to quote to support. Shown in small mono text with a copy button. */
  requestId?: string;
  /** Milliseconds on screen. Loading toasts stay until you update them. */
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type Toast = ToastInput & { id: number; tone: ToastTone; duration: number };

export type ToastApi = {
  show: (input: ToastInput) => number;
  update: (id: number, patch: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
};

const MOST = 6;
const GAP = 8;
const PEEK = 12;
const FALLBACK = 76;
const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

const TONE_WORD: Record<ToastTone, string> = { info: "Note", success: "Done", error: "Error", loading: "Working" };

type ToastStore = { api: ToastApi; toasts: Toast[] };

const ToastContext = createContext<ToastStore | null>(null);

function useToastStore(): ToastStore {
  const store = useContext(ToastContext);
  if (!store) throw new Error("useToast needs a ToastProvider above it.");
  return store;
}

/** Returns `show`, `update` and `dismiss`. Needs a ToastProvider or ToastStoreProvider above it. */
export function useToast(): ToastApi {
  return useToastStore().api;
}

/** Holds the toast state and gives `useToast()` its API. It draws nothing, so mount <ToastStack /> where you want the stack. */
export function ToastStoreProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const api = useMemo<ToastApi>(
    () => ({
      show(input) {
        const id = nextId.current;
        nextId.current += 1;
        setToasts((current) => [{ tone: "info" as const, duration: 5000, ...input, id }, ...current].slice(0, MOST));
        return id;
      },
      update(id, patch) {
        setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)));
      },
      dismiss(id) {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      },
    }),
    [],
  );

  const store = useMemo<ToastStore>(() => ({ api, toasts }), [api, toasts]);

  return <ToastContext value={store}>{children}</ToastContext>;
}

/** Wrap the app in this once, then call `useToast()` anywhere. The stack is drawn right here, after the children. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastStoreProvider>
      {children}
      <ToastStack />
    </ToastStoreProvider>
  );
}

/** The stack itself. It must sit inside a ToastStoreProvider (or ToastProvider). */
export function ToastStack({ className }: { className?: string }) {
  const { api, toasts } = useToastStore();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const front = heights[toasts[0]?.id ?? -1] ?? FALLBACK;

  let running = 0;
  const offsets = toasts.map((toast) => {
    const offset = running;
    running += (heights[toast.id] ?? FALLBACK) + GAP;
    return offset;
  });
  const height = toasts.length === 0 ? 0 : open ? running - GAP : front + Math.min(toasts.length - 1, 2) * PEEK;

  return (
    <motion.div
      role="region"
      aria-label="Notifications"
      initial={false}
      animate={{ height }}
      transition={reduced ? { duration: 0 } : SPRING}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        // Escape dismisses the front toast. Focus is inside the stack when this fires.
        if (event.key === "Escape" && toasts[0]) api.dismiss(toasts[0].id);
      }}
      className={cn("fixed top-4 right-4 z-50 w-[min(23rem,calc(100vw-2rem))]", className)}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast, index) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            index={index}
            total={toasts.length}
            offset={offsets[index] ?? 0}
            open={open}
            frontHeight={front}
            onMeasure={(id, value) =>
              setHeights((current) => (current[id] === value ? current : { ...current, [id]: value }))
            }
            onDismiss={api.dismiss}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

type ToastItemProps = {
  toast: Toast;
  index: number;
  total: number;
  offset: number;
  open: boolean;
  frontHeight: number;
  onMeasure: (id: number, height: number) => void;
  onDismiss: (id: number) => void;
};

function ToastItem({ toast, index, total, offset, open, frontHeight, onMeasure, onDismiss }: ToastItemProps) {
  const { id, tone, title, body, duration, action, requestId } = toast;
  const reduced = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const paused = useRef(open);
  const measure = useRef(onMeasure);
  const isError = tone === "error";

  useEffect(() => {
    paused.current = open;
    measure.current = onMeasure;
  });

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => measure.current(id, element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [id]);

  useEffect(() => {
    if (tone === "loading") return;
    let left = duration;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last));
      last = now;
      if (!paused.current) left -= dt;
      if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, left / duration).toFixed(4)})`;
      if (left <= 0) {
        onDismiss(id);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [id, tone, duration, onDismiss]);

  const depth = Math.min(index, 3);

  return (
    <motion.div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      data-tone={tone}
      layout={false}
      drag={open || index === 0 ? "x" : false}
      dragSnapToOrigin
      dragElastic={0.8}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 110 || Math.abs(info.velocity.x) > 600) onDismiss(id);
      }}
      initial={reduced ? false : { opacity: 0, y: -28, scale: 0.96 }}
      animate={{
        opacity: !open && index > 2 ? 0 : 1,
        y: open ? offset : depth * PEEK,
        scale: open ? 1 : 1 - depth * 0.05,
        height: !open && index > 0 ? frontHeight : "auto",
      }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
      transition={reduced ? { duration: 0 } : SPRING}
      className="absolute inset-x-0 top-0 origin-bottom cursor-grab touch-pan-y overflow-hidden border border-ink bg-paper-raised text-ink active:cursor-grabbing"
      style={{ zIndex: total - index }}
    >
      <div
        ref={content}
        className="flex items-start gap-3 p-4 pr-10 transition-opacity duration-200"
        style={{ opacity: open || index === 0 ? 1 : 0 }}
      >
        <motion.span
          key={tone}
          initial={reduced ? false : { opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
        >
          <ToneMark tone={tone} />
        </motion.span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            <span className="sr-only">{TONE_WORD[tone]}: </span>
            {title}
          </p>
          {body && <p className="mt-0.5 text-sm text-ink-soft">{body}</p>}
          {requestId !== undefined && <RequestReference id={requestId} />}
          {action && (
            <Button
              type="button"
              size="sm"
              variant={isError ? "danger" : "secondary"}
              className="mt-3"
              onClick={() => {
                action.onClick();
                onDismiss(id);
              }}
            >
              {action.label}
            </Button>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Dismiss: ${title}`}
        onClick={() => onDismiss(id)}
        className="absolute top-3 right-3 flex size-7 cursor-pointer items-center justify-center text-ink-muted transition-colors duration-200 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        style={{ visibility: open || index === 0 ? "visible" : "hidden" }}
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {tone !== "loading" && (
        <span
          ref={bar}
          aria-hidden="true"
          className={cn("absolute inset-x-0 bottom-0 h-0.5 origin-left", TONE_BAR[tone])}
        />
      )}
    </motion.div>
  );
}

const TONE_BAR: Record<Exclude<ToastTone, "loading">, string> = {
  info: "bg-ink",
  success: "bg-cobalt",
  error: "bg-vermilion",
};

function ToneMark({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <Check className="size-4 text-cobalt" aria-hidden />;
  if (tone === "error") return <AlertTriangle className="size-4 text-vermilion" aria-hidden />;
  if (tone === "info") return <Info className="size-4 text-ink-soft" aria-hidden />;
  return (
    <span aria-hidden="true" className="flex gap-0.5">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 bg-amber-deep motion-safe:animate-pulse"
          style={{ animationDelay: `${index * 160}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

/** The request id to quote to support, in small mono text, with a copy button. */
function RequestReference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard can be blocked. The id stays on screen, so it can be selected by hand.
    }
  }

  return (
    <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
      <span className="min-w-0 truncate select-all">Request id: {id}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Request id copied" : "Copy request id"}
        className="flex shrink-0 cursor-pointer items-center gap-1 uppercase tracking-[0.12em] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
