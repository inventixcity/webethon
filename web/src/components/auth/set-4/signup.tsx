"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { siteConfig } from "@/config/site";
import { durationSeconds, easing, motionTransition, useReducedMotion } from "@/lib/motion";
import { type SignupProgress, SignupForm } from "../forms/signup-form";
import { Shell, titleClass } from "./shell";
import { Silk } from "./silk";

const EMPTY: SignupProgress = { name: "", email: "", passwordLength: 0, strength: 0, terms: false };

export default function Signup() {
  const reduced = useReducedMotion();
  const [silk] = useState(() => new Silk({ full: true }));
  const [progress, setProgress] = useState(EMPTY);
  const typed = useRef(0);

  const onProgress = useCallback(
    (next: SignupProgress) => {
      setProgress(next);
      const total = next.name.length + next.email.length + next.passwordLength;
      if (total !== typed.current) {
        typed.current = total;
        silk.touch(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6);
      }
    },
    [silk],
  );

  const steps = [
    progress.name.length > 1,
    progress.email.includes("@"),
    progress.passwordLength >= 8,
    progress.terms,
  ].filter(Boolean).length;

  return (
    <Shell>
      <div className="grid flex-1 lg:grid-cols-2">
        <div className="relative grid min-h-[60dvh] place-items-center overflow-hidden p-6 md:p-12">
          <div className="absolute inset-0">
            <ShaderCanvas scene={silk} />
          </div>

          {/* An invitation, filled in live as the form is. */}
          <div
            aria-hidden="true"
            className="relative w-full max-w-md bg-paper-raised px-8 py-10 text-center outline outline-1 -outline-offset-8 outline-vermilion/60"
          >
            <p className="text-[11px] tracking-[0.3em] text-ink-muted uppercase">{siteConfig.name}</p>
            <p className="mt-6 text-[15px] text-ink-soft">requests the pleasure of the company of</p>
            <p className="mt-3 min-h-[1.2em] truncate font-heading text-4xl italic md:text-5xl">
              {progress.name || <span className="text-ink/20">your name</span>}
            </p>
            <div className="mx-auto mt-3 h-px w-full origin-center bg-vermilion transition-transform duration-(--duration-slow) ease-(--ease-move)" style={{ transform: `scaleX(${0.1 + (steps / 4) * 0.9})` }} />
            <p className="mt-3 min-h-5 truncate text-[15px] text-ink-soft">{progress.email || "at this address"}</p>
            <div className="mx-auto mt-6 flex justify-center gap-1.5">
              {Array.from({ length: 8 }, (_, index) => (
                <span
                  // Fixed pearls along the card's foot.
                  key={index}
                  className={`size-1.5 transition-colors duration-(--duration-base) ${
                    index < Math.round(progress.strength * 8) ? "bg-vermilion" : "bg-ink/10"
                  }`}
                />
              ))}
            </div>
            <AnimatePresence>
              {progress.terms && (
                <motion.span
                  initial={{ opacity: 0, scale: 2.4 }}
                  animate={{ opacity: 1, scale: 1, rotate: -8 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition(reduced, { duration: durationSeconds.base, ease: easing.enter })}
                  className="absolute right-6 bottom-6 grid size-16 place-items-center bg-vermilion-deep font-heading text-2xl text-paper italic"
                >
                  {siteConfig.mark}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>

        <section className="flex flex-col justify-center px-6 py-10 md:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className={titleClass}>
              <Reveal>Your invitation</Reveal>
            </h1>
            <p className="mt-2 mb-7 text-[17px] text-ink-soft">It&apos;s written out as you type.</p>
            <SignupForm layout="stack" onProgress={onProgress} />
          </div>
        </section>
      </div>
    </Shell>
  );
}
