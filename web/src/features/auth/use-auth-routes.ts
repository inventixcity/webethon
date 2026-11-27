"use client";

import { usePathname } from "next/navigation";

/** Keeps links inside the set being viewed, so /auth/3/login leads to /auth/3/signup. */
export function useAuthRoutes() {
  const pathname = usePathname();
  const base = pathname.match(/^\/auth\/\d+(?=\/)/)?.[0] ?? "";

  return {
    login: `${base}/login`,
    signup: `${base}/signup`,
    forgot: `${base}/forgot-password`,
    reset: `${base}/reset-password`,
    verify: (email: string, next?: "reset") =>
      `${base}/verify?email=${encodeURIComponent(email)}${next ? `&next=${next}` : ""}`,
  };
}
