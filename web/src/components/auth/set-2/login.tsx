"use client";

import { useRef, useState } from "react";
import { AsciiCanvas } from "@/components/ascii/ascii-canvas";
import { OwlScene } from "@/components/ascii/scenes/owl";
import { Reveal } from "@/components/motion/reveal";
import { siteConfig } from "@/config/site";
import { AuthHeader } from "../auth-header";
import { type LoginEvents, LoginForm } from "../forms/login-form";


function createOwl() {
  const owl = new OwlScene();
  const events: LoginEvents = {
    onValues: (email, passwordLength) => owl.setText(email, passwordLength),
    onEmailFocus: () => owl.setMood("watching"),
    // The form sits to the owl's right, so its eyes sweep rightward along the caret.
    onCaret: (position) => owl.look(0.2 + position * 0.8),
    onPasswordFocus: (shown) => owl.setMood(shown ? "peeking" : "looking-away"),
    onReveal: (shown) => owl.setMood(shown ? "peeking" : "looking-away"),
    onLeave: () => owl.setMood("idle"),
    onStatus: (status) => owl.setMood(status === "pending" ? "thinking" : status === "ok" ? "happy" : "wrong"),
  };
  return { owl, events };
}

export default function Login() {
  const [{ owl, events }] = useState(createOwl);
  const skyRef = useRef<HTMLDivElement>(null);

  // Until a field has focus, the owl watches the pointer.
  function onPointerMove(event: React.PointerEvent) {
    const sky = skyRef.current?.getBoundingClientRect();
    if (!sky) return;
    owl.lookAtPointer((event.clientX - (sky.left + sky.width / 2)) / (sky.width / 2));
  }

  return (
    <main onPointerMove={onPointerMove} className="flex min-h-dvh flex-col">
      <AuthHeader index="01" section="Access" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div ref={skyRef} className="relative h-[46dvh] overflow-hidden lg:h-auto">
          <AsciiCanvas scene={owl} cell={15} className="absolute inset-0" />
        </div>

        <section className="flex flex-col justify-center border-rule px-5 py-10 md:px-10 lg:border-l xl:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal>Welcome back.</Reveal>
            </h1>
            <p className="mt-3 mb-9 text-base text-ink-soft">It won&apos;t look while you type your password.</p>
            <LoginForm {...events} />
          </div>
        </section>
      </div>
    </main>
  );
}
