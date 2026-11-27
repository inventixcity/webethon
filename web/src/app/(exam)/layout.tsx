import { connection } from "next/server";
import { ErrorPage } from "@/components/errors/error-page";
import { requireUser } from "@/features/auth/require-user";
import { isServiceUnavailable } from "@/lib/api/server";

/**
 * The exam workspace is a full-height surface with no app header. The route still needs a signed-in user,
 * and the API is asked on every request, never cached.
 */
export default async function ExamLayout({ children }: { children: React.ReactNode }) {
  // Build-time prerender stops here, so the API is never asked during `next build`.
  await connection();
  try {
    await requireUser();
  } catch (error) {
    // The API is down or overloaded: show the 503 page with a retry. Redirects and other errors pass through.
    if (isServiceUnavailable(error)) return <ErrorPage code={503} />;
    throw error;
  }
  return <div className="flex min-h-dvh flex-col bg-paper text-ink">{children}</div>;
}
