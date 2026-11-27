"use client";

import { LottieLoop } from "@/components/motion/lottie-loop";
import { Ticker } from "@/components/motion/ticker";
import { AuthHeader } from "../auth-header";
import { ForgotForm } from "../forms/forgot-form";

const tickerItems = ["Happens to everyone", "No harm done", "Back in a minute", "Your work is safe"];

export default function Forgot() {
  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="03" section="Recovery" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* The one vermilion moment on this page. Light tokens keep the keys inked in both modes. */}
        <section data-theme="light" className="grid min-h-[38dvh] place-items-center bg-vermilion p-8 lg:p-14">
          <div className="aspect-[4/3] w-full max-w-[34rem]">
            <LottieLoop src="/lottie/keys.json" speed={0.7} />
          </div>
        </section>

        <section className="flex flex-col justify-center px-5 py-10 md:px-10 lg:px-14">
          <ForgotForm />
        </section>
      </div>

      <Ticker items={tickerItems} reverse className="border-t border-ink py-3" />
    </main>
  );
}
