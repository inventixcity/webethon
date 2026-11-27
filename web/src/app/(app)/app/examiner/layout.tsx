import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "Examiner", robots: { index: false, follow: false } };

/** Examiner area. Only examiners (and admins, who can see every exam) get past this point. */
export default async function ExaminerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.role !== "examiner" && user.role !== "admin") redirect("/app");

  return (
    <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
      <nav aria-label="Examiner" className="flex flex-wrap gap-x-8 gap-y-3 border-b border-rule py-4 font-mono text-[11px] tracking-[0.12em] uppercase">
        <Link href="/app/examiner" className="underline-offset-4 hover:underline">
          Overview
        </Link>
        <Link href="/app/examiner/exams" className="underline-offset-4 hover:underline">
          Exams
        </Link>
        <Link href="/app/examiner/questions" className="underline-offset-4 hover:underline">
          Question bank
        </Link>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
