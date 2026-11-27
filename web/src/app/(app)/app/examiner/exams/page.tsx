import type { Metadata } from "next";
import { ExamList } from "@/components/exams/exam-list";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Exams", robots: { index: false, follow: false } };

export default function ExamsPage() {
  return (
    <div className="grid gap-10 pb-10">
      <PageHeader index="02" eyebrow="Exams" title="Exams" description="Every exam you run, by phase. Open one to set up its paper, candidates and results." />
      <ExamList />
    </div>
  );
}
