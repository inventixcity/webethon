"use client";

import { Activity, WifiOff, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NetworkQuality } from "./model";

const QUALITY_LABEL: Record<NetworkQuality, string> = {
  good: "Connection good",
  unstable: "Connection unstable",
  offline: "Offline",
};

/** Small quality pill for the top bar. Text and icon, so colour is never the only signal. */
export function NetworkIndicator({ quality }: { quality: NetworkQuality }) {
  const Icon = quality === "offline" ? WifiOff : quality === "unstable" ? Activity : Wifi;
  return (
    <p
      role="status"
      aria-live="polite"
      data-quality={quality}
      className={cn(
        "flex min-w-0 items-center gap-2 border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase",
        quality === "offline" ? "border-ink bg-ink text-paper" : "border-(--ws-line) text-ink-soft",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{QUALITY_LABEL[quality]}</span>
    </p>
  );
}

/** Full-width banners for offline and unstable connections. Answers keep saving either way. */
export function NetworkBanners({ quality }: { quality: NetworkQuality }) {
  if (quality === "good") return null;
  if (quality === "offline") {
    return (
      <div role="status" className="border-b border-ink bg-ink px-4 py-3 font-sans text-sm text-paper sm:px-6">
        You&apos;re offline. Keep answering — your answers are saved on this device and will sync when you
        reconnect. Your time is not paused.
      </div>
    );
  }
  return (
    <div role="status" className="border-b border-(--ws-line) bg-paper-raised px-4 py-3 font-sans text-sm text-ink sm:px-6">
      Your connection is unstable. Answers are saved and retried automatically. Your time is not paused.
    </div>
  );
}
