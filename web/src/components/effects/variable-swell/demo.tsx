import { VariableSwell } from "./variable-swell";

export default function VariableSwellDemo() {
  return (
    <main className="flex min-h-dvh flex-col bg-paper px-5 py-8 text-ink sm:px-10 lg:px-16">
      <header className="flex justify-between border-b border-rule pb-5 font-mono text-[11px] uppercase tracking-[0.12em]"><span>Living letterforms</span><span>03 / 05</span></header>
      <section className="flex flex-1 flex-col justify-center py-12 lg:py-20">
        <p className="max-w-52 text-base leading-relaxed">Space to slow down.<br />Room to become.</p>
        <VariableSwell text="Breathe." className="my-8 lg:my-12" />
        <div className="flex items-end justify-between gap-6"><p className="max-w-64 text-sm leading-relaxed text-ink-soft">A gentle reminder that nothing<br className="hidden sm:block" /> needs to hold its shape forever.</p><span className="h-12 w-3 shrink-0 bg-vermilion" aria-hidden="true" /></div>
      </section>
      <footer className="flex justify-between gap-6 border-t border-rule pt-6 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted"><span>Move over the letters</span><span>Always becoming</span></footer>
    </main>
  );
}
