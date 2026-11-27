import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/api/server";
import { AppShell } from "@/components/app-shell/app-shell";

export default async function Layout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  const user = await getSessionUser();
  if (!user || user.role !== "admin") notFound();
  return (
    <AppShell user={{ displayName: user.displayName, email: user.email, role: user.role }}>{children}</AppShell>
  );
}
