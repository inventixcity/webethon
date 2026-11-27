"use client";

import { useEffect, useState } from "react";

/** The device clock, refreshed every second. Only used for display; the server decides every deadline. */
export function useTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Offset from the device clock to the server clock. The server's serverNow is compared with the device's
 * clock at the moment the answer arrived, so a wrong device clock only shifts the display, never the rules.
 */
export function serverOffset(serverNow: string, receivedAt: number): number {
  const parsed = Date.parse(serverNow);
  return Number.isFinite(parsed) ? parsed - receivedAt : 0;
}
