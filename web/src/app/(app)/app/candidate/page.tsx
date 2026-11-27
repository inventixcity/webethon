import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CandidateDashboard } from "@/components/candidate/candidate-dashboard";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "My exams", robots: { index: false, follow: false } };

/** The candidate's own exams. The page only checks the role; the API decides which exams are visible. */
export default async function CandidateHomePage() {
  const user = await requireUser();
  if (user.role !== "candidate") redirect("/app");

  return (
    <main className="mx-auto w-full max-w-5xl min-w-0 px-5 py-10 md:px-8 md:py-16">
      <CandidateDashboard />
    </main>
  );
}
