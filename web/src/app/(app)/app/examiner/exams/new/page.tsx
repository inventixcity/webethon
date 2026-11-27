import type { Metadata } from "next";
import Link from "next/link";
import { ExamForm } from "@/components/exams/exam-form";

export const metadata: Metadata = { title: "New exam", robots: { index: false, follow: false } };

export default function NewExamPage() {
  return (
    <div className="grid gap-10 py-10">
      <nav aria-label="Breadcrumb" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
        <Link href="/app/examiner/exams" className="underline-offset-4 hover:text-ink hover:underline">
          Exams
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-soft">New</span>
      </nav>
      <div className="grid gap-4">
        <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">01 / Create</p>
        <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] font-medium tracking-[-0.03em]">New exam</h1>
        <p className="max-w-prose text-ink-soft">
          Set the basics now. The paper, candidates and publishing come next, and you can change most settings until the exam is published.
        </p>
      </div>
      <ExamForm mode="create" />
    </div>
  );
}
