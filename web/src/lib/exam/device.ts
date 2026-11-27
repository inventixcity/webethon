const DEVICE_KEY = "invigil.device";

export function deviceId(): string {
  if (typeof window === "undefined") return "";
  const current = window.localStorage.getItem(DEVICE_KEY);
  if (current && /^[A-Za-z0-9_-]{24}$/.test(current)) return current;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const value = Array.from(bytes, (byte) => alphabet[byte & 63]).join("");
  window.localStorage.setItem(DEVICE_KEY, value);
  return value;
}

/** Compatibility name used by workspace UI. */
export const getDeviceId = deviceId;

export function attemptHeaders(): Record<string, string> {
  const id = deviceId();
  return id ? { "X-Attempt-Device": id } : {};
}
