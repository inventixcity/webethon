import { connection } from "next/server";
import { requireUser } from "@/features/auth/require-user";

/**
 * The exam workspace is a full-height surface with no app header. The route still needs a signed-in user,
 * and the API is asked on every request, never cached.
 */
export default async function ExamLayout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  await requireUser();
  return <div className="flex min-h-dvh flex-col bg-paper text-ink">{children}</div>;
}
