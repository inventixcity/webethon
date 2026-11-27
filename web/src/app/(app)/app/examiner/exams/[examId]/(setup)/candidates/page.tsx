import type { Metadata } from "next";
import { CandidatesPanel } from "@/components/exams/candidates-panel";

export const metadata: Metadata = { title: "Exam candidates", robots: { index: false, follow: false } };

export default async function ExamCandidatesPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <CandidatesPanel examId={examId} />;
}
