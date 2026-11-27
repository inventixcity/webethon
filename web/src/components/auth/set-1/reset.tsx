"use client";

import { LottieLoop } from "@/components/motion/lottie-loop";
import { Reveal } from "@/components/motion/reveal";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { ResetForm } from "../forms/reset-form";


export default function Reset() {
  return (
    <main className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <section data-theme="dark" className="flex min-h-0 flex-1 flex-col border-b border-rule bg-paper text-ink">
        <AuthHeader index="05" section="New password" className="border-rule" />
        <div className="grid min-h-0 flex-1 items-end gap-6 overflow-hidden px-5 pt-6 pb-5 md:grid-cols-12 md:px-8">
          <h1 className="text-[clamp(3.25rem,min(11vw,19vh),12rem)] leading-none font-semibold tracking-[-0.03em] md:col-span-8">
            <Reveal className="block">New key,</Reveal>
            <Reveal className="-mt-[0.14em] block" delay={0.1}>
              same door.
            </Reveal>
          </h1>
          <div className="size-40 md:col-span-4 md:size-[min(22vw,36vh)] md:justify-self-end">
            <LottieLoop src="/lottie/vault-lock.json" mode="bounce" stillAt={1} className="scale-[1.2]" />
          </div>
        </div>
      </section>

      <ResetForm />
    </main>
  );
}
