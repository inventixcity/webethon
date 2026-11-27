import { AppShell } from "@/components/app-shell/app-shell";
import { requireUser } from "@/features/auth/require-user";
import { connection } from "next/server";

/** Everything under /app needs a signed-in user. The API is asked on every request, never cached. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  const user = await requireUser();
  return (
    <AppShell user={{ displayName: user.displayName, email: user.email, role: user.role }}>{children}</AppShell>
  );
}
