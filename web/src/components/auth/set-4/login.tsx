"use client";

import { useState } from "react";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { type LoginEvents, LoginForm } from "../forms/login-form";
import { Shell, titleClass } from "./shell";
import { Silk } from "./silk";

const OPEN = 0.25;
const FOCUS = 0.22;
/** Drawn in close around the form, for privacy, but never over it. */
const DISCREET = 0.18;

function createSilk() {
  const silk = new Silk({ open: OPEN });
  let side = 0;
  const events: LoginEvents = {
    onValues: (email, passwordLength) => {
      // Each keystroke sends a ripple from alternating drapes, at the height of the form.
      if (email.length + passwordLength === 0) return;
      side = 1 - side;
      silk.touch(side ? 0.74 : 0.26, 0.45 + Math.random() * 0.15);
    },
    onEmailFocus: () => silk.part(FOCUS),
    onPasswordFocus: (shown) => silk.part(shown ? FOCUS : DISCREET),
    onReveal: (shown) => silk.part(shown ? FOCUS : DISCREET),
    onLeave: () => silk.part(OPEN),
    onStatus: (status) => {
      if (status === "ok") silk.part(0.56);
      if (status === "wrong") {
        silk.part(DISCREET);
        silk.touch(0.3, 0.5);
        silk.touch(0.7, 0.5);
      }
    },
  };
  return { silk, events };
}

export default function Login() {
  const [{ silk, events }] = useState(createSilk);

  return (
    <Shell>
      <div className="absolute inset-0 top-16">
        <ShaderCanvas scene={silk} />
      </div>
      <div className="relative z-10 flex flex-1 items-center justify-center py-8 max-lg:pt-28">
        <section className="w-full max-w-[29rem] bg-paper px-6 py-8 sm:px-10">
          <div className="mb-8 text-center">
            <h1 className={titleClass}>
              <Reveal>Welcome back</Reveal>
            </h1>
            <p className="mt-2 text-[17px] text-ink-soft">The drapes draw close for your password.</p>
          </div>
          <LoginForm {...events} />
        </section>
      </div>
    </Shell>
  );
}
