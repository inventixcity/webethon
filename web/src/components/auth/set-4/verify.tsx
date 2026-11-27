"use client";

import { useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { maskEmail } from "@/features/auth/schemas";
import { useVerify } from "@/features/auth/use-verify";
import { VerifyPanel } from "../forms/verify-panel";
import { PearlScene } from "./pearls";
import { Shell, titleClass } from "./shell";
import { Silk } from "./silk";

export default function Verify({ email, next }: { email?: string; next?: string }) {
  const [{ silk, pearls }] = useState(() => ({ silk: new Silk({ full: true }), pearls: new PearlScene() }));
  const verify = useVerify({
    next,
    onCode: (code) => {
      pearls.setCode(code);
      if (code) silk.touch(code.length / 7, 0.5);
    },
    onStatus: (status) => pearls.setStatus(status),
  });

  return (
    <Shell>
      <div className="grid flex-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <section className="relative min-h-[44dvh] overflow-hidden">
          <div className="absolute inset-0">
            <ShaderCanvas scene={silk} />
          </div>
          <div className="absolute inset-0">
            <LiveCanvas scene={pearls} />
          </div>
        </section>

        <section className="flex flex-col justify-center px-6 py-10 md:px-14">
          <div className="mx-auto w-full max-w-md">
            <h1 className={titleClass}>
              <Reveal key={verify.verified ? "done" : "wait"}>{verify.verified ? "The clasp is closed" : "A string of six"}</Reveal>
            </h1>
            <p className="mt-2 mb-8 text-[17px] text-ink-soft">
              {verify.verified
                ? "You're verified."
                : email
                  ? `Six digits are on their way to ${maskEmail(email)}.`
                  : "Six digits are on their way."}
            </p>
            <VerifyPanel verify={verify} next={next} cellClassName="font-heading text-3xl italic" />
          </div>
        </section>
      </div>
    </Shell>
  );
}
