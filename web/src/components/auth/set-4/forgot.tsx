"use client";

import { useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { ForgotField } from "../forms/forgot-field";
import { Shell, titleClass } from "./shell";
import { Silk } from "./silk";
import { StitchScene } from "./stitch";

export default function Forgot() {
  const [{ silk, stitch }] = useState(() => ({ silk: new Silk({ full: true }), stitch: new StitchScene() }));

  return (
    <Shell>
      <div className="relative z-10 flex flex-1 flex-col">
        <section className="relative min-h-[46dvh] flex-1 overflow-hidden">
          <div className="absolute inset-0">
            <ShaderCanvas scene={silk} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={stitch} />
          </div>
        </section>

        <section className="grid gap-x-16 gap-y-6 px-6 py-8 md:grid-cols-2 md:px-16">
          <div>
            <h1 className={titleClass}>
              <Reveal>A small repair</Reveal>
            </h1>
            <p className="mt-2 text-[17px] text-ink-soft">One stitch for every letter of your address.</p>
          </div>
          <ForgotField
            onType={(length, valid) => {
              stitch.typed(length, valid);
              silk.touch(0.1 + (Math.min(length, 30) / 30) * 0.8, 0.5);
            }}
            onSent={(sent) => stitch.setSent(sent)}
            onError={() => stitch.rejected()}
          />
        </section>
      </div>
    </Shell>
  );
}
