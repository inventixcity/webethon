"use client";

import { useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { ForgotField } from "../forms/forgot-field";
import { LanternScene } from "./lantern";
import { Shell, titleClass } from "./shell";

export default function Forgot() {
  const [lantern] = useState(() => new LanternScene());

  return (
    <Shell scene={lantern}>
      <h1 className={titleClass}>
        <Reveal>Light the way back</Reveal>
      </h1>
      <p className="mt-2 mb-7 text-[15px] text-ink-soft">Every letter brings another firefly home.</p>
      <ForgotField
        onType={(length, valid) => lantern.typed(length, valid)}
        onSent={(sent) => lantern.setSent(sent)}
        onError={() => lantern.rejected()}
        submitLabel="Set them free"
      />
    </Shell>
  );
}
