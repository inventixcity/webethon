"use client";

import { useCallback, useEffect, useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { TreeScene } from "@/components/ascii/scenes/tree";
import { Reveal } from "@/components/motion/reveal";
import { useTheme } from "@/components/theme/theme";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { type SignupProgress, SignupForm } from "../forms/signup-form";

export default function Signup() {
  const [tree] = useState(() => new TreeScene());
  const theme = useTheme();

  useEffect(() => {
    tree.setSurface(theme === "light");
  }, [tree, theme]);

  const onProgress = useCallback(
    ({ name, email, passwordLength, strength, terms }: SignupProgress) => {
      tree.update({ name: name.length, email: email.length, password: passwordLength, strength, terms });
    },
    [tree],
  );

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="02" section="Membership" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col gap-6 border-rule px-5 pt-8 pb-5 md:px-8 lg:border-r">
          <div>
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal>Open an account.</Reveal>
            </h1>
            <p className="mt-3 text-base text-ink-soft">Every letter you type grows it.</p>
          </div>
          <div className="relative min-h-72 flex-1">
            <AsciiCanvas scene={tree} align="bottom" className="absolute inset-0" />
          </div>
        </section>

        <SignupForm onProgress={onProgress} />
      </div>
    </main>
  );
}
