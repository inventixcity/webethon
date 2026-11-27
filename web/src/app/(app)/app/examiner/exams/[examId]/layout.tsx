import type { ReactNode } from "react";
import { ExamHeader } from "@/components/exams/exam-header";

/** Shared chrome for one exam: title, phase, window, actions and the tab bar. Pages below render their own content. */
export default async function ExamLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ examId: string }>;
}) {
  const { examId } = await params;
  return (
    <div className="grid min-w-0 gap-0">
      <ExamHeader examId={examId} />
      {children}
    </div>
  );
}
