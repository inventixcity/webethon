import type { Metadata } from "next";
import { ExamOverview } from "@/components/exams/exam-overview";

export const metadata: Metadata = { title: "Exam overview", robots: { index: false, follow: false } };

export default async function ExamOverviewPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <ExamOverview examId={examId} />;
}
