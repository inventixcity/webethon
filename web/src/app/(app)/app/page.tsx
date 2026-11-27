import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "Home", robots: { index: false, follow: false } };

/** Sends each signed-in role to its own home. The API decides what each role may open, not this page. */
export default async function AppHomePage() {
  const user = await requireUser();

  if (user.role === "admin") redirect("/admin");
  if (user.role === "examiner") redirect("/app/examiner");
  if (user.role === "candidate") redirect("/app/candidate");

  // An unknown role gets a plain message, not a redirect, so no two pages can send the visitor back and forth.
  return (
    <main className="mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-6xl content-start px-5 md:px-8">
      <PageHeader
        eyebrow="Account"
        title="Your account has no role yet"
        description={`Ask your institution to assign a role to ${user.email}. Accounts are created by your institution.`}
      />
    </main>
  );
}
