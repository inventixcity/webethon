import { GradingView } from "@/components/grading/grading-view";

export default async function GradingPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <GradingView examId={examId} />;
}
