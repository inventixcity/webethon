"use client";

import { PendulumType } from "./pendulum-type";
import { DemoFrame } from "../ink-tide/demo-frame";

export default function PendulumTypeDemo() {
  return <DemoFrame name="Pendulum type" number="03" caption="Words with a life of their own." instruction="Brush past a letter to set it swinging. A passing breeze keeps the conversation going.">
    <PendulumType headline={"Make\nit move."} accentIndex={11} className="min-h-[600px] md:min-h-[min(76svh,840px)]" />
  </DemoFrame>;
}
