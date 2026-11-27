"use client";

import { useState } from "react";
import { DemoFrame } from "../demo-frame";
import { RotaryKnob } from "./rotary-knob";

export default function Demo() {
  const [creativity, setCreativity] = useState(60);
  const [budget, setBudget] = useState(4);

  return (
    <DemoFrame index="Controls" title="Rotary knob" note="Good for settings like AI temperature. Drag round it, scroll on it, or use the arrow keys.">
      <div className="flex flex-wrap justify-center gap-16">
        <RotaryKnob label="Creativity" value={creativity} onChange={setCreativity} format={(value) => `${value}%`} />
        <RotaryKnob label="Budget" value={budget} onChange={setBudget} min={0} max={10} step={1} format={(value) => `$${value}k`} />
      </div>
    </DemoFrame>
  );
}
