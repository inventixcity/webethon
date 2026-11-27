"use client";

import { useEffect, useSyncExternalStore } from "react";

export type NetworkQuality = "good" | "unstable" | "offline";
export type NetworkStatus = { online: boolean; quality: NetworkQuality; lastOkAt: number | null; rttMs: number | null };
const initial: NetworkStatus = { online: true, quality: "good", lastOkAt: null, rttMs: null };
let status = initial;
let samples: boolean[] = [];
let failures = 0;
let simulatedOffline = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach((listener) => listener());
export const isNetworkOnline = () => (typeof navigator === "undefined" || navigator.onLine) && !simulatedOffline;

/** Sandbox demonstration uses the same durable save and reconnect paths as an actual outage. */
export function setSimulatedOffline(on: boolean): void {
  simulatedOffline = on;
  status = { ...status, online: isNetworkOnline(), quality: isNetworkOnline() ? "unstable" : "offline" };
  notify();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(on ? "offline" : "online"));
}
const record = (rtt: number | null) => {
  failures = rtt === null ? failures + 1 : 0;
  samples = [...samples.slice(-2), rtt === null || rtt > 1500];
  const online = isNetworkOnline() && failures < 2;
  status = { online, quality: !online ? "offline" : samples.length === 3 && samples.every(Boolean) ? "unstable" : "good", lastOkAt: rtt === null ? status.lastOkAt : Date.now(), rttMs: rtt };
  notify();
};

export function useNetworkStatus(): NetworkStatus {
  const snapshot = useSyncExternalStore(subscribe, () => status, () => initial);
  useEffect(() => {
    const onChange = () => {
      status = { ...status, online: isNetworkOnline(), quality: isNetworkOnline() ? "unstable" : "offline" };
      notify();
    };
    if (!navigator.onLine) onChange();
    window.addEventListener("online", onChange); window.addEventListener("offline", onChange);
    return () => { window.removeEventListener("online", onChange); window.removeEventListener("offline", onChange); };
  }, []);
  return snapshot;
}

export function useHeartbeatQuality(): { status: NetworkStatus; record: (rtt: number | null) => void } {
  return { status: useNetworkStatus(), record };
}
