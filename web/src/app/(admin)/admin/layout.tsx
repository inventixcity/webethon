import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getSessionUser, isServiceUnavailable } from "@/lib/api/server";
import { AppShell } from "@/components/app-shell/app-shell";
import { ErrorPage } from "@/components/errors/error-page";

export default async function Layout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  let user;
  try {
    user = await getSessionUser();
  } catch (error) {
    // The API is down or overloaded: show the 503 page with a retry, not a 500.
    if (isServiceUnavailable(error)) return <ErrorPage code={503} />;
    throw error;
  }
  if (!user || user.role !== "admin") notFound();
  return (
    <AppShell user={{ displayName: user.displayName, email: user.email, role: user.role }}>{children}</AppShell>
  );
}
