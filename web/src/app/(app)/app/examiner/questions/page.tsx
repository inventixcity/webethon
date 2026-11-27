import type { Metadata } from "next";
import Link from "next/link";
import { QuestionBank } from "@/components/questions/question-bank";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Question bank", robots: { index: false, follow: false } };

/** The examiner's question bank. Everything is filtered and paged by the API. */
export default function QuestionBankPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 pb-10 md:px-8 md:pb-16">
      <PageHeader
        index="01"
        eyebrow="Question bank"
        title="Questions"
        description="Every question you can draw on, across all exams. Filter, edit or import in bulk."
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href="/app/examiner/questions/import">Import</Link>
            </Button>
            <Button asChild>
              <Link href="/app/examiner/questions/new">New question</Link>
            </Button>
          </>
        }
      />

      <QuestionBank />
    </main>
  );
}
