"use client";

import { VelocityMarquee } from "./velocity-marquee";

const big = "py-3 text-[clamp(3rem,9vw,8rem)] leading-none font-semibold tracking-[-0.03em]";

export default function Demo() {
  return (
    <div className="bg-paper text-ink">
      <section className="flex min-h-dvh flex-col justify-center gap-2 overflow-hidden py-16">
        <p className="px-5 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase md:px-16">
          Layout. Scroll hard, or grab a row and drag it.
        </p>
        <h1 className="sr-only">Velocity marquee</h1>
        <VelocityMarquee text="Scroll to speed up" className={big} />
        <VelocityMarquee text="Drag to take control" reverse className={`${big} border-y border-ink`} />
        <VelocityMarquee text="Lean into the motion" speed={110} className={big} />
      </section>
      <div className="h-[80dvh]" />
    </div>
  );
}
