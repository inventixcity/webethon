"use client";

import { useCallback, useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { KeyScene } from "@/components/ascii/scenes/key";
import { Reveal } from "@/components/motion/reveal";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { ResetForm } from "../forms/reset-form";


export default function Reset() {
  const [lock] = useState(() => new KeyScene());
  const onValues = useCallback(
    (password: string, confirm: string, strength: number) => lock.update(password, confirm, strength),
    [lock],
  );

  return (
    <main className="flex min-h-dvh flex-col">
      <section className="flex flex-1 flex-col border-b border-rule bg-paper-sunk">
        <AuthHeader index="05" section="New password" />
        <div className="grid flex-1 gap-6 overflow-hidden px-5 pt-8 pb-6 md:px-8 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal className="block">New key,</Reveal>
              <Reveal className="-mt-[0.14em] block" delay={0.1}>
                same door.
              </Reveal>
            </h1>
            <p className="mt-3 max-w-[30ch] text-base text-ink-soft">
              Your password cuts the key. Type it again to set the pins.
            </p>
          </div>
          <div className="relative min-h-60 lg:col-span-8">
            <AsciiCanvas scene={lock} className="absolute inset-0" />
          </div>
        </div>
      </section>

      <ResetForm onValues={onValues} />
    </main>
  );
}
