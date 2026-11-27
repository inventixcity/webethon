import { AppShell } from "@/components/app-shell/app-shell";
import { ErrorPage } from "@/components/errors/error-page";
import { requireUser } from "@/features/auth/require-user";
import { isServiceUnavailable } from "@/lib/api/server";
import { connection } from "next/server";

/** Everything under /app needs a signed-in user. The API is asked on every request, never cached. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    // The API is down or overloaded: show the 503 page with a retry. Redirects and other errors pass through.
    if (isServiceUnavailable(error)) return <ErrorPage code={503} />;
    throw error;
  }
  return (
    <AppShell user={{ displayName: user.displayName, email: user.email, role: user.role }}>{children}</AppShell>
  );
}
