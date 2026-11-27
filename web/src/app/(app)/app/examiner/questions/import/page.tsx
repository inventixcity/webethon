import type { Metadata } from "next";
import { QuestionImportWizard } from "@/components/questions/import-wizard";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Import questions", robots: { index: false, follow: false } };

export default function ImportQuestionsPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 pb-10 md:px-8 md:pb-16">
      <PageHeader
        index="03"
        eyebrow="Import"
        banner="bg-examiner"
        title="Import questions"
        breadcrumb={[{ label: "Question bank", href: "/app/examiner/questions" }, { label: "Import" }]}
        description="Bring questions in from a spreadsheet or file. You review every row before anything is saved."
      />

      <QuestionImportWizard />
    </main>
  );
}
