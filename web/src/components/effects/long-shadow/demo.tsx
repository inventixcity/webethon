import { LongShadow } from "./long-shadow";

export default function LongShadowDemo() {
  return (
    <main className="min-h-dvh bg-paper px-5 py-8 text-ink sm:px-10 lg:px-16">
      <header className="flex justify-between border-b border-rule pb-5 font-mono text-[11px] uppercase tracking-[0.12em]"><span>A matter of time</span><span>05 / 05</span></header>
      <div className="mt-10 flex justify-between gap-8"><p className="max-w-52 text-base leading-relaxed">The light moves.<br />The moment is yours.</p><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Present tense<br />Always in motion</span></div>
      <LongShadow text="NOW." className="my-2" />
      <footer className="flex justify-between gap-8 border-t border-rule pt-6"><p className="max-w-64 text-sm leading-relaxed text-ink-soft">Make something that lasts<br />longer than the moment.</p><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Light / Form / Time</span></footer>
    </main>
  );
}
