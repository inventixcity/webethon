"use client";

import { InkTide } from "./ink-tide";
import { DemoFrame } from "./demo-frame";

export default function InkTideDemo() {
  return <DemoFrame name="Ink tide" number="01" caption="Every edge is a new beginning." instruction="Let it unfold. Ink gathers, separates, and quietly changes the words it touches.">
    <InkTide headline={"Nothing\nstays still."} className="min-h-[560px] md:min-h-[min(72svh,800px)]" />
  </DemoFrame>;
}
