"use client";

import { useEffect, useState } from "react";

export type NetworkQuality = "good" | "unstable" | "offline";
export type NetworkStatus = { online: boolean; quality: NetworkQuality; lastOkAt: number | null; rttMs: number | null };

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>({ online: typeof navigator === "undefined" || navigator.onLine, quality: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "good", lastOkAt: null, rttMs: null });
  useEffect(() => {
    const onChange = () => setStatus((old) => ({ ...old, online: navigator.onLine, quality: navigator.onLine ? old.quality : "offline" }));
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => { window.removeEventListener("online", onChange); window.removeEventListener("offline", onChange); };
  }, []);
  return status;
}

export function useHeartbeatQuality(): { status: NetworkStatus; record: (rtt: number | null) => void } {
  const [status, setStatus] = useState<NetworkStatus>({ online: typeof navigator === "undefined" || navigator.onLine, quality: "good", lastOkAt: null, rttMs: null });
  const [samples, setSamples] = useState<boolean[]>([]);
  const record = (rtt: number | null) => {
    const bad = rtt === null || rtt > 1500;
    setSamples((old) => [...old.slice(-2), bad]);
    setStatus({ online: navigator.onLine && rtt !== null, quality: !navigator.onLine || rtt === null ? "offline" : [...samples.slice(-2), bad].filter(Boolean).length === 3 ? "unstable" : "good", lastOkAt: rtt === null ? status.lastOkAt : Date.now(), rttMs: rtt });
  };
  return { status, record };
}
