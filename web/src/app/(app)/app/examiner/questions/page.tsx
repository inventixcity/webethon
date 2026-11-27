import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { QuestionBank } from "@/components/questions/question-bank";

export const metadata: Metadata = { title: "Question bank", robots: { index: false, follow: false } };

/** The examiner's question bank. Everything is filtered and paged by the API. */
export default function QuestionBankPage() {
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-10 md:px-8 md:py-16">
      <header className="grid gap-6 md:flex md:items-end md:justify-between md:gap-10">
        <div className="grid gap-5">
          <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            <span aria-hidden className="size-1.5 bg-vermilion" />
            01 / Question bank
          </p>
          <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em]">Questions.</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary">
            <Link href="/app/examiner/questions/import">Import</Link>
          </Button>
          <Button asChild>
            <Link href="/app/examiner/questions/new">New question</Link>
          </Button>
        </div>
      </header>

      <QuestionBank />
    </main>
  );
}
