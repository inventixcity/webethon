"use client";

import { useCallback, useState } from "react";
import { LiveCanvas } from "@/components/canvas/live-canvas";
import { Reveal } from "@/components/motion/reveal";
import { siteConfig } from "@/config/site";
import { ResetForm } from "../forms/reset-form";
import { SealScene } from "./seal";
import { Shell, titleClass } from "./shell";

export default function Reset() {
  const [seal] = useState(() => new SealScene(siteConfig.mark));
  const onValues = useCallback(
    (password: string, confirm: string, strength: number) => seal.update(password, confirm, strength),
    [seal],
  );

  return (
    <Shell>
      <div className="grid flex-1 lg:grid-cols-2">
        <section className="relative min-h-[40dvh] bg-paper-sunk">
          <div className="absolute inset-0">
            <LiveCanvas scene={seal} />
          </div>
        </section>
        <section className="flex flex-col justify-center px-6 py-10 md:px-14">
          <div className="mx-auto w-full max-w-md">
            <h1 className={titleClass}>
              <Reveal>Set in gold</Reveal>
            </h1>
            <p className="mt-2 mb-8 text-[17px] text-ink-soft">
              A strong password gilds the letter. Repeat it to close the ring.
            </p>
            <ResetForm layout="column" hideMeter onValues={onValues} />
          </div>
        </section>
      </div>
    </Shell>
  );
}
