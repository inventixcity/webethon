import type { Metadata } from "next";
import { ReviewPanel } from "@/components/exams/review-panel";

export const metadata: Metadata = { title: "Review and publish", robots: { index: false, follow: false } };

export default async function ExamReviewPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <ReviewPanel examId={examId} />;
}
