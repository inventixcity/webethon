import { AnalyticsView } from "@/components/analytics/analytics-view";

export default async function AnalyticsPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <AnalyticsView examId={examId} />;
}
