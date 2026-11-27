"use client";

import { useState } from "react";
import { HalftoneField } from "./halftone-field";
import { DemoFrame } from "../ink-tide/demo-frame";

export default function HalftoneFieldDemo() {
  const [spacing, setSpacing] = useState(7);
  return <DemoFrame name="Halftone field" number="04" caption="The whole is in the details." instruction="Move across the surface to send a ripple through the print. Change the grain to see a different rhythm." controls={
    <div aria-label="Print grain" role="group" className="flex w-fit border border-ink font-mono text-[11px] tracking-[.08em] uppercase">
      {[{ value: 7, label: "Fine" }, { value: 12, label: "Coarse" }].map(({ value, label }) =>
        <button key={value} type="button" aria-pressed={spacing === value} onClick={() => setSpacing(value)} className={`min-h-11 min-w-20 px-4 ${spacing === value ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-paper-sunk"}`}>{label}</button>)}
    </div>
  }>
    <HalftoneField headline={"More\nthan words."} spacing={spacing} className="min-h-[560px] md:min-h-[min(72svh,800px)]" />
  </DemoFrame>;
}
