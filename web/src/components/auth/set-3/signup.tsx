"use client";

import { useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { AuthHeader } from "../auth-header";
import { type SignupProgress, SignupForm } from "../forms/signup-form";
import { MemberCard } from "./member-card";

const EMPTY: SignupProgress = { name: "", email: "", passwordLength: 0, strength: 0, terms: false };

export default function Signup() {
  const [progress, setProgress] = useState(EMPTY);

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="02" section="Membership" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col justify-center px-5 py-8 md:px-10 xl:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal>Open an account.</Reveal>
            </h1>
            <p className="mt-3 mb-7 text-base text-ink-soft">Your card is being pressed as you type.</p>
            <SignupForm layout="stack" onProgress={setProgress} />
          </div>
        </section>

        <section className="flex items-center justify-center border-rule bg-paper-sunk p-5 md:p-10 lg:border-l xl:p-14">
          <MemberCard progress={progress} />
        </section>
      </div>
    </main>
  );
}
