"use client";

import { useCallback, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { passwordRules } from "@/features/auth/schemas";
import { AuthHeader } from "../auth-header";
import { ResetForm } from "../forms/reset-form";
import { StrengthGauge } from "./strength-gauge";

const LAMP_LABELS = ["Length", "Case", "Number", "Symbol"];

export default function Reset() {
  const [state, setState] = useState({ strength: 0, typed: 0, rules: [false, false, false, false], matched: false });

  const onValues = useCallback((password: string, confirm: string, strength: number) => {
    setState({
      strength,
      typed: password.length + confirm.length,
      rules: passwordRules.map((rule) => rule.test(password)),
      matched: password.length > 0 && password === confirm,
    });
  }, []);

  const lamps = [
    ...LAMP_LABELS.map((label, index) => ({ label, on: state.rules[index] ?? false })),
    { label: "Match", on: state.matched },
  ];

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="05" section="New password" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col justify-center px-5 py-10 md:px-10 xl:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal>Set a new password.</Reveal>
            </h1>
            <p className="mt-3 mb-9 text-base text-ink-soft">Watch the needle. Aim for the far right.</p>
            <ResetForm layout="column" hideMeter onValues={onValues} />
          </div>
        </section>

        <section className="flex items-center justify-center border-rule bg-paper-sunk p-5 md:p-10 lg:border-l xl:p-14">
          <StrengthGauge strength={state.strength} typed={state.typed} lamps={lamps} />
        </section>
      </div>
    </main>
  );
}
