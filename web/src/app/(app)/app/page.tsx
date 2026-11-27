import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
    <main className="grid min-h-[calc(100dvh-4rem)] content-center gap-4 px-5 py-16 md:px-8">
      <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
        <span aria-hidden="true" className="size-1.5 bg-vermilion" />
        Account
      </p>
      <h1 className="max-w-[22ch] text-[clamp(2rem,4vw,3.25rem)] leading-[1.02] font-medium tracking-[-0.035em]">
        Your account has no role yet.
      </h1>
      <p className="max-w-[60ch] text-base text-ink-soft">
        Ask your institution to assign a role to {user.email}. Accounts are created by your institution.
      </p>
    </main>
  );
}
