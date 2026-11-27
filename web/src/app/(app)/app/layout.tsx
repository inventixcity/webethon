import { AppHeader } from "@/components/app-shell/app-header";
import { requireUser } from "@/features/auth/require-user";
import { connection } from "next/server";

/** Everything under /app needs a signed-in user. The API is asked on every request, never cached. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  await requireUser();
  return <div className="min-h-dvh bg-paper text-ink"><AppHeader />{children}</div>;
}
