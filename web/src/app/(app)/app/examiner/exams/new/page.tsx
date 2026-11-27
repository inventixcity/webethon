import type { Metadata } from "next";
import { ExamForm } from "@/components/exams/exam-form";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "New exam", robots: { index: false, follow: false } };

export default function NewExamPage() {
  return (
    <div className="grid gap-10 pb-10">
      <PageHeader
        index="01"
        eyebrow="Create"
        banner="bg-examiner"
        title="New exam"
        breadcrumb={[{ label: "Exams", href: "/app/examiner/exams" }, { label: "New" }]}
        description="Set the basics now. The paper, candidates and publishing come next, and you can change most settings until the exam is published."
      />
      <ExamForm mode="create" />
    </div>
  );
}
