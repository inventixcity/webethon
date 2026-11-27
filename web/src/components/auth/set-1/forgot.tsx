"use client";

import { LottieLoop } from "@/components/motion/lottie-loop";
import { AuthHeader } from "../auth-header";
import { ForgotForm } from "../forms/forgot-form";


export default function Forgot() {
  return (
    <main className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <AuthHeader index="03" section="Recovery" />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* The one vermilion moment on this page. Light tokens keep the keys inked in both modes. */}
        <section data-theme="light" className="grid min-h-[38dvh] min-h-0 place-items-center bg-vermilion p-8 lg:p-10">
          <div className="aspect-[4/3] w-full max-w-[34rem]">
            <LottieLoop src="/lottie/keys.json" speed={0.7} />
          </div>
        </section>

        <section className="flex min-h-0 flex-col justify-center overflow-hidden px-5 py-8 md:px-10 lg:px-14">
          <ForgotForm />
        </section>
      </div>
    </main>
  );
}
