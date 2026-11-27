import type { ReactNode } from "react";

/** Shared presentation shell for the material studies; the effects need no shell. */
export function DemoFrame({ name, number, instruction, caption, children, controls }: {
  name: string; number: string; instruction: string; caption: string; children: ReactNode; controls?: ReactNode;
}) {
  return <main className="min-h-svh bg-paper font-sans text-ink">
    <header className="mx-6 flex min-h-24 items-center justify-between gap-6 border-b border-rule md:mx-12">
      <div className="flex items-baseline gap-4 md:gap-8">
        <span className="font-mono text-[11px] tracking-[.1em] text-ink-muted">{number} / 04</span>
        <h1 className="text-xl font-medium tracking-[-0.03em] md:text-2xl">{name}</h1>
      </div>
      <p className="hidden font-mono text-[11px] tracking-[.1em] text-ink-muted uppercase sm:block">Material studies</p>
    </header>
    {children}
    <footer className="mx-6 grid gap-6 border-t border-rule py-7 md:mx-12 md:grid-cols-[1fr_1fr_auto] md:items-start md:gap-12">
      <p className="max-w-[330px] text-xl leading-tight tracking-[-.025em] md:text-2xl">{caption}</p>
      <p className="max-w-[340px] text-sm leading-relaxed text-ink-muted">{instruction}</p>
      {controls}
    </footer>
  </main>;
}
