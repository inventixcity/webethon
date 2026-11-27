import type { Metadata } from "next";
import { QuestionsEditor } from "@/components/exams/questions-editor";

export const metadata: Metadata = { title: "Exam questions", robots: { index: false, follow: false } };

export default async function ExamQuestionsPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <QuestionsEditor examId={examId} />;
}
