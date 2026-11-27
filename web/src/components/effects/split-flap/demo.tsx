import { SplitFlap } from "./split-flap";

export default function SplitFlapDemo() {
  return (
    <main className="flex min-h-dvh flex-col bg-paper px-5 py-8 text-ink sm:px-10 lg:px-16">
      <header className="flex justify-between border-b border-rule pb-5 font-mono text-[11px] uppercase tracking-[0.12em]"><span>The next chapter</span><span>04 / 05</span></header>
      <section className="flex flex-1 flex-col justify-center py-16 lg:py-24">
        <div className="mb-8 flex items-end justify-between gap-8"><h1 className="max-w-xl text-[clamp(2.5rem,5vw,5rem)] font-medium leading-[0.95] tracking-[-0.03em]">Where do<br />we go from here?</h1><span className="bg-vermilion px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-paper">Now boarding</span></div>
        <div className="border-y border-ink py-4"><SplitFlap phrases={["ONWARD", "EXPLORE", "IMAGINE", "BEGIN"]} columns={7} interval={7} label="Next destination" /></div>
        <div className="mt-6 flex justify-between gap-8 font-mono text-[11px] uppercase tracking-[0.1em]"><span>Destination / Open</span><span>Departure / Any time</span></div>
      </section>
      <footer className="flex flex-wrap justify-between gap-4 border-t border-rule pt-6"><p className="text-sm text-ink-soft">There is always something ahead.</p><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Stay for the next departure</span></footer>
    </main>
  );
}
