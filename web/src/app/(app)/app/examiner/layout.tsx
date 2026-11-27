import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "Examiner", robots: { index: false, follow: false } };

/** Examiner area. Only examiners (and admins, who can see every exam) get past this point. The sidebar and top bar come from the app shell. */
export default async function ExaminerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.role !== "examiner" && user.role !== "admin") redirect("/app");

  return <div className="min-w-0">{children}</div>;
}
