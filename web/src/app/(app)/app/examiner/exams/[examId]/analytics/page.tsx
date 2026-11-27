import { AnalyticsView } from "@/components/analytics/analytics-view";
import { FairnessSection } from "@/components/analytics/fairness-section";

export default async function AnalyticsPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return (
    <>
      <AnalyticsView examId={examId} />
      <FairnessSection examId={examId} />
    </>
  );
}
