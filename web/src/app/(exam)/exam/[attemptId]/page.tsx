import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExamWorkspace } from "@/components/workspace/workspace";

export const metadata: Metadata = {
  title: "Exam",
  robots: { index: false, follow: false },
};

type PageProps = { params: Promise<{ attemptId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ExamPage({ params }: PageProps) {
  const { attemptId } = await params;
  if (!UUID.test(attemptId)) notFound();
  return <ExamWorkspace attemptId={attemptId} />;
}
