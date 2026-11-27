import { InvertLens } from "./invert-lens";

export default function InvertLensDemo() {
  return (
    <main className="min-h-dvh bg-paper px-5 py-8 text-ink sm:px-10 lg:px-16">
      <header className="flex justify-between border-b border-rule pb-5 font-mono text-[11px] uppercase tracking-[0.12em]"><span>Optical studies</span><span>01 / 05</span></header>
      <InvertLens size={280} className="mt-8 min-h-[580px] border-b border-rule lg:min-h-[680px]">
        <div className="flex items-start justify-between gap-6 font-mono text-[11px] uppercase tracking-[0.1em]"><span>A different point of view</span><span className="text-right">Positive<br />Negative</span></div>
        <h1 className="relative z-10 mt-16 max-w-[1000px] text-[clamp(5.2rem,12.8vw,12rem)] font-semibold leading-[0.85] tracking-[-0.03em]">Look<br />closer.</h1>
        <div className="mt-12 grid grid-cols-1 gap-8 pb-10 md:grid-cols-12">
          <div className="flex h-20 items-stretch gap-1 md:col-span-5" aria-hidden="true">{[1, 3, 1, 7, 2, 1, 5, 1, 2, 4, 1, 8, 2, 1, 4].map((n, i) => <div key={i} className="bg-ink" style={{ flex: n }} />)}</div>
          <p className="max-w-80 text-base leading-relaxed md:col-span-4 md:col-start-9">A small shift in perspective.<br />An entirely different impression.</p>
        </div>
      </InvertLens>
      <footer className="flex justify-between gap-4 pt-6 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted"><span>Move across the surface</span><span>Study in contrast</span></footer>
    </main>
  );
}
