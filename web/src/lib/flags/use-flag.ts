"use client";

import { useContext } from "react";
import { FlagsContext, type FlagsState } from "./provider";

/** The whole flags state. Must be used inside <FlagsProvider>. */
export function useFlags(): FlagsState {
  const state = useContext(FlagsContext);
  if (state === null) throw new Error("useFlags must be used inside <FlagsProvider>.");
  return state;
}

/**
 * One flag for the viewer. A missing key is off, with no value. While the flags load, enabled is false.
 */
export function useFlag(key: string): { enabled: boolean; value: unknown; loading: boolean } {
  const { flags, loading } = useFlags();
  const entry = Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : undefined;
  return { enabled: entry?.enabled === true, value: entry?.value, loading };
}
