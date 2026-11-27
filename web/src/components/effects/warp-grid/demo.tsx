"use client";

import { WarpGrid } from "./warp-grid";
import { DemoFrame } from "../ink-tide/demo-frame";

export default function WarpGridDemo() {
  return <DemoFrame name="Warp grid" number="02" caption="A little room for the unexpected." instruction="Move through the field. The grid follows your presence while a single red cell travels with the wave.">
    <WarpGrid headline={"Order,\nin motion."} description="Even the most precise systems can leave space for possibility." className="min-h-[560px] md:min-h-[min(72svh,800px)]" />
  </DemoFrame>;
}
