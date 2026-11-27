"use client";

import { DemoFrame } from "../demo-frame";
import { CompareSlider } from "./compare-slider";

const STATS = [
  ["Orders", "1,284"],
  ["Returned", "2.1%"],
  ["On time", "97%"],
];

const BARS = [38, 62, 45, 80, 56, 92, 70];

function Sample({ theme }: { theme: "light" | "dark" }) {
  return (
    <div data-theme={theme} className="bg-paper p-5 pt-14 text-ink md:p-10 md:pt-16">
      <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">This week</p>
      <p className="mt-2 text-[clamp(1.75rem,4vw,2.75rem)] leading-tight font-semibold tracking-[-0.03em]">Harbour Supply Co.</p>
      <div className="mt-6 grid grid-cols-3 gap-0.5">
        {STATS.map(([name, value]) => (
          <div key={name} className="bg-paper-raised p-3 md:p-4">
            <p className="text-xs text-ink-muted">{name}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums md:text-2xl">{value}</p>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-6 flex h-28 items-end gap-0.5 md:h-36">
        {BARS.map((height, index) => (
          <span key={index} className={index === 5 ? "flex-1 bg-vermilion" : "flex-1 bg-ink"} style={{ height: `${height}%` }} />
        ))}
      </div>
    </div>
  );
}

export default function Demo() {
  return (
    <DemoFrame index="Layout" title="Compare slider" note="For before and after, or two versions of one design. Here it's the same screen in both modes.">
      <CompareSlider
        label="Compare light and dark"
        beforeLabel="Light"
        afterLabel="Dark"
        before={<Sample theme="light" />}
        after={<Sample theme="dark" />}
      />
    </DemoFrame>
  );
}
