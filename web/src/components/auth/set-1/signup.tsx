"use client";

import { LottieLoop } from "@/components/motion/lottie-loop";
import { Reveal } from "@/components/motion/reveal";
import { Ticker } from "@/components/motion/ticker";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { SignupForm } from "../forms/signup-form";

const tickerItems = ["Open an account", siteConfig.tagline, "Four lines", "One minute"];

export default function Signup() {
  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="02" section="Membership" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_3rem]">
        <section className="flex flex-col justify-between gap-8 overflow-hidden border-rule px-5 py-8 md:px-8 lg:border-r">
          <h1 className="text-[clamp(3.75rem,min(8.6vw,17vh),10rem)] leading-none font-semibold tracking-[-0.03em]">
            <Reveal className="block">Open</Reveal>
            <Reveal className="-mt-[0.14em] block" delay={0.1}>
              an
            </Reveal>
            <Reveal className="-mt-[0.14em] block" delay={0.2}>
              account.
            </Reveal>
          </h1>
          <div className="size-[min(70vw,17rem)] self-start lg:size-[min(26vw,34vh)]">
            <LottieLoop src="/lottie/blocks.json" speed={0.55} />
          </div>
        </section>

        <SignupForm />

        {/* Absolute, so the marquee's length never sets the height of the page. */}
        <div className="relative hidden border-l border-rule lg:block">
          <Ticker
            vertical
            items={tickerItems}
            duration={60}
            className="absolute inset-0 justify-center overflow-hidden"
          />
        </div>
      </div>
    </main>
  );
}
