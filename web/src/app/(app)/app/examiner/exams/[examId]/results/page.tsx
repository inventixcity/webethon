import { ResultsView } from "./results-view";

export default async function ResultsPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  return <ResultsView examId={examId} />;
}
