import { MonitorView } from "@/components/monitor/monitor-view";

export default async function MonitorPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <MonitorView examId={examId} />;
}
