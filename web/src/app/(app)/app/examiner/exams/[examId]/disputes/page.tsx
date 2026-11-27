import { DisputesView } from "@/components/disputes/disputes-view";

export default async function DisputesPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <DisputesView examId={examId} />;
}
