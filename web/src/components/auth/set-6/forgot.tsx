"use client";

import { useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { ForgotField } from "../forms/forgot-field";
import { Aurora } from "./aurora";
import { CompassScene } from "./compass";
import { Shell } from "./shell";

export default function Forgot() {
  const [{ aurora, compass }] = useState(() => ({ aurora: new Aurora(0.32), compass: new CompassScene() }));

  return (
    <Shell
      sky={
        <>
          <div className="absolute inset-0">
            <ShaderCanvas scene={aurora} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={compass} />
          </div>
        </>
      }
      title={<Reveal>Find true north</Reveal>}
      note="The needle hunts as you type, and settles once your address is right."
    >
      <div className="px-5 py-6 md:px-8">
        <ForgotField
          row
          onType={(length, valid) => {
            compass.typed(valid);
            aurora.pulse(0.1 + (Math.min(length, 30) / 30) * 0.8);
            aurora.rise(valid ? 0.8 : 0.32);
          }}
          onSent={(sent) => {
            if (sent) compass.send();
          }}
          onError={() => compass.rejected()}
        />
      </div>
    </Shell>
  );
}
