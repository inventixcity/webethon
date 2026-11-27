"use client";

import { DemoFrame } from "../demo-frame";
import { MagneticButton } from "./magnetic-button";

export default function Demo() {
  return (
    <DemoFrame index="Controls" title="Magnetic button" note="Come at it from any side. It leans toward you, and the fill grows from where you entered.">
      <div className="flex flex-wrap items-center justify-center gap-10">
        <MagneticButton>Get started</MagneticButton>
        <MagneticButton pull={0.5}>Book a call</MagneticButton>
      </div>
    </DemoFrame>
  );
}
