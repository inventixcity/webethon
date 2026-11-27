"use client";

import { LottieLoop } from "@/components/motion/lottie-loop";
import { Reveal } from "@/components/motion/reveal";
import { Ticker } from "@/components/motion/ticker";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { ResetForm } from "../forms/reset-form";

const tickerItems = ["New key", "Same door", siteConfig.tagline, "Keep it somewhere safe"];

export default function Reset() {
  return (
    <main className="flex min-h-dvh flex-col">
      <section data-theme="dark" className="flex flex-1 flex-col border-b border-rule bg-paper text-ink">
        <AuthHeader index="05" section="New password" className="border-rule" />
        <div className="grid flex-1 items-end gap-6 overflow-hidden px-5 pt-8 pb-6 md:grid-cols-12 md:px-8">
          <h1 className="text-[clamp(3.25rem,min(12vw,24vh),14rem)] leading-none font-semibold tracking-[-0.03em] md:col-span-8">
            <Reveal className="block">New key,</Reveal>
            <Reveal className="-mt-[0.14em] block" delay={0.1}>
              same door.
            </Reveal>
          </h1>
          <div className="size-40 md:col-span-4 md:size-[min(28vw,44vh)] md:justify-self-end">
            <LottieLoop src="/lottie/vault-lock.json" mode="bounce" stillAt={1} className="scale-[1.2]" />
          </div>
        </div>
        <Ticker items={tickerItems} className="border-t border-rule py-3" />
      </section>

      <ResetForm />
    </main>
  );
}
