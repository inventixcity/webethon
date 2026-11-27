import type { Metadata } from "next";
import { ExaminerHome } from "@/components/exams/examiner-home";

export const metadata: Metadata = { title: "Examiner overview", robots: { index: false, follow: false } };

export default function ExaminerOverviewPage() {
  return <ExaminerHome />;
}
