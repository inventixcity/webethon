import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { QuestionImportWizard } from "@/components/questions/import-wizard";

export const metadata: Metadata = { title: "Import questions", robots: { index: false, follow: false } };

export default function ImportQuestionsPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-10 md:px-8 md:py-16">
      <header className="grid gap-5">
        <Link
          href="/app/examiner/questions"
          className="inline-flex w-fit items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase transition-colors duration-(--duration-fast) hover:text-vermilion-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Question bank
        </Link>
        <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
          <span aria-hidden className="size-1.5 bg-vermilion" />
          03 / Import
        </p>
        <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em]">
          Import questions.
        </h1>
      </header>

      <QuestionImportWizard />
    </main>
  );
}
