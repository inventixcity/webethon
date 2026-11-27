import { WaveText } from "./WaveText";

export default function WaveTextDemo() {
  return (
    <main>
      <WaveText
        headline={"Nothing\nstands still."}
        eyebrow="A study in motion"
        edition="Always becoming"
        description="A little movement can change everything. Make space for what comes next."
        actionLabel="Explore the possibilities"
        actionHref="#possibilities"
        caption="Move gently. Make a ripple."
      />
      <section id="possibilities" className="grid gap-8 bg-paper px-6 py-24 text-ink sm:grid-cols-2 sm:px-16">
        <h2 className="max-w-xl text-5xl leading-none font-medium tracking-[-0.03em] sm:text-7xl">The next chapter<br />is yours to shape.</h2>
        <p className="max-w-sm self-end text-base leading-relaxed">Start with a small idea. Follow your curiosity. Leave enough room for something unexpected.</p>
      </section>
    </main>
  );
}
