"use client";

import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useRef } from "react";
import { hash } from "@/components/ascii/grid";
import { siteConfig } from "@/config/site";
import { durationSeconds, easing, motionTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { SignupProgress } from "../forms/signup-form";

const PUNCHES = 16;
const SPRING = { stiffness: 160, damping: 18, mass: 0.6 };

/** Turns the email into a card number, so it rolls over as the address is typed. */
function cardNumber(email: string) {
  const digits = Array.from({ length: 8 }, (_, index) => {
    let total = 0;
    for (let i = 0; i < email.length; i++) total += email.charCodeAt(i) * (i + index + 1);
    return Math.floor(hash(total, index + 1) * 10);
  }).join("");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

function grade(strength: number) {
  if (strength >= 1) return "A";
  if (strength >= 0.75) return "B";
  if (strength >= 0.5) return "C";
  return "-";
}

/** A membership card pressed live: it leans toward the pointer and dips with every keystroke. */
export function MemberCard({ progress, className }: { progress: SignupProgress; className?: string }) {
  const { name, email, passwordLength, strength, terms } = progress;
  const reduced = useReducedMotion();
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const press = useMotionValue(1);
  const rotateX = useSpring(tiltX, SPRING);
  const rotateY = useSpring(tiltY, SPRING);
  const scale = useSpring(press, { stiffness: 620, damping: 22 });
  const typed = useRef(0);

  useEffect(() => {
    if (reduced) return;
    function onPointerMove(event: PointerEvent) {
      tiltY.set(((event.clientX / window.innerWidth) * 2 - 1) * 12);
      tiltX.set(((event.clientY / window.innerHeight) * 2 - 1) * -10);
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [reduced, tiltX, tiltY]);

  const total = name.length + email.length + passwordLength;
  useEffect(() => {
    if (total === typed.current) return;
    typed.current = total;
    if (reduced) return;
    press.set(0.97);
    const id = window.setTimeout(() => press.set(1), 70);
    return () => window.clearTimeout(id);
  }, [total, press, reduced]);

  return (
    <div className={cn("w-full max-w-2xl", className)} style={{ perspective: 1100 }}>
      <motion.div
        aria-hidden="true"
        style={{ rotateX, rotateY, scale }}
        className="relative flex aspect-[1.586] w-full flex-col justify-between overflow-hidden border border-ink bg-paper-raised p-[5.5%]"
      >
        <div className="flex items-start justify-between font-mono text-[clamp(9px,1.2cqw,12px)] tracking-[0.14em] uppercase">
          <span className="flex items-center gap-3">
            <span className="grid size-7 place-items-center bg-ink text-xs font-bold text-paper">
              {siteConfig.mark}
            </span>
            {siteConfig.name}
          </span>
          <span className="text-right tabular-nums">
            Member
            <br />
            <span className="text-ink-muted">{cardNumber(email)}</span>
          </span>
        </div>

        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">Issued to</p>
          <p className="truncate text-[clamp(1.75rem,4.4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
            {name || <span className="text-ink/20">Your name</span>}
            <span className="ml-1 inline-block h-[0.72em] w-[0.08em] animate-blink bg-vermilion align-baseline motion-reduce:animate-none" />
          </p>
          <p className="mt-2 truncate font-mono text-sm text-ink-soft">{email || "you@studio.com"}</p>
        </div>

        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="mb-1.5 font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">Security punch</p>
            <div className="flex gap-1">
              {Array.from({ length: PUNCHES }, (_, index) => (
                <span
                  // Punch holes are fixed positions on the card.
                  key={index}
                  className={cn(
                    "size-2.5 transition-colors duration-(--duration-fast) sm:size-3",
                    index < passwordLength ? "bg-ink" : "bg-ink/10",
                  )}
                />
              ))}
            </div>
          </div>
          <p className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">
            Grade <span className="text-xl font-medium text-ink">{grade(strength)}</span>
          </p>
        </div>

        <AnimatePresence>
          {terms && (
            <motion.div
              initial={{ opacity: 0, scale: 2.2, rotate: -2 }}
              animate={{ opacity: 1, scale: 1, rotate: -9 }}
              exit={{ opacity: 0 }}
              transition={motionTransition(reduced === true, { duration: durationSeconds.base, ease: easing.enter })}
              className="absolute top-[30%] right-[7%] border-[3px] border-vermilion px-4 py-1.5 font-mono text-lg font-bold tracking-[0.1em] text-vermilion uppercase"
            >
              Admitted
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
