import { TypeRiver } from "./type-river";

export default function TypeRiverDemo() {
  return (
    <main className="min-h-dvh bg-paper px-5 py-8 text-ink sm:px-10 lg:px-16">
      <header className="flex justify-between border-b border-rule pb-5 font-mono text-[11px] uppercase tracking-[0.12em]"><span>Current affairs</span><span>02 / 05</span></header>
      <TypeRiver headline={"Make room\nfor ideas."} characters="FLOW/01:·" className="mt-5" />
      <footer className="grid gap-6 border-t border-rule pt-6 sm:grid-cols-2"><p className="max-w-80 text-base leading-relaxed">Everything moves. The important things give it direction.</p><p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted sm:text-right">Move through the current<br /><span className="mt-2 inline-block">It finds its way back.</span></p></footer>
    </main>
  );
}
