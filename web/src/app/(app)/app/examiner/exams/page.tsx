import type { Metadata } from "next";
import { ExamList } from "@/components/exams/exam-list";

export const metadata: Metadata = { title: "Exams", robots: { index: false, follow: false } };

export default function ExamsPage() {
  return (
    <div className="grid gap-10 py-10">
      <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] font-medium tracking-[-0.03em]">Exams</h1>
      <ExamList />
    </div>
  );
}
