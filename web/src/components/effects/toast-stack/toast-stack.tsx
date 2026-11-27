"use client";

import { AlertTriangle, Check, Info, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "error" | "loading";

export type ToastInput = {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** Milliseconds on screen. Loading toasts stay until you update them. */
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type Toast = ToastInput & { id: number; tone: ToastTone; duration: number };

type ToastApi = {
  show: (input: ToastInput) => number;
  update: (id: number, patch: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
};

const MOST = 6;
const GAP = 8;
const PEEK = 12;
const FALLBACK = 76;
const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast() {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider above it.");
  return api;
}

/** Wrap the app in this once, then call `useToast()` anywhere. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
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

  return (
    <ToastContext value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={api.dismiss} />
    </ToastContext>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
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
      transition={SPRING}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      className="fixed top-4 right-4 z-50 w-[min(23rem,calc(100vw-2rem))]"
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
            onDismiss={onDismiss}
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
  const { id, tone, title, body, duration, action } = toast;
  const reduced = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const paused = useRef(open);
  const measure = useRef(onMeasure);

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
      role={tone === "error" ? "alert" : "status"}
      layout={false}
      drag={open || index === 0 ? "x" : false}
      dragSnapToOrigin
      dragElastic={0.8}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 110 || Math.abs(info.velocity.x) > 600) onDismiss(id);
      }}
      initial={{ opacity: 0, y: -28, scale: 0.96 }}
      animate={{
        opacity: !open && index > 2 ? 0 : 1,
        y: open ? offset : depth * PEEK,
        scale: open ? 1 : 1 - depth * 0.05,
        height: !open && index > 0 ? frontHeight : "auto",
      }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
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
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
        >
          <ToneMark tone={tone} />
        </motion.span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {body && <p className="mt-0.5 text-sm text-ink-soft">{body}</p>}
          {action && (
            <button
              type="button"
              onClick={() => {
                action.onClick();
                onDismiss(id);
              }}
              className="mt-2 cursor-pointer font-mono text-[11px] tracking-[0.1em] uppercase underline underline-offset-4"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Dismiss: ${title}`}
        onClick={() => onDismiss(id)}
        className="absolute top-3 right-3 cursor-pointer p-1 text-ink-muted hover:text-ink"
        style={{ visibility: open || index === 0 ? "visible" : "hidden" }}
      >
        <X className="size-3.5" />
      </button>
      <span ref={bar} aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-vermilion" />
    </motion.div>
  );
}

function ToneMark({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <Check className="size-4" />;
  if (tone === "error") return <AlertTriangle className="size-4 text-vermilion-deep" />;
  if (tone === "info") return <Info className="size-4" />;
  return (
    <span aria-hidden="true" className="flex gap-0.5">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 bg-ink motion-safe:animate-pulse"
          style={{ animationDelay: `${index * 160}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}
