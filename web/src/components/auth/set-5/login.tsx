"use client";

import { useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { type LoginEvents, LoginForm } from "../forms/login-form";
import { PondScene } from "./pond";
import { Shell, titleClass } from "./shell";

function createPond() {
  const pond = new PondScene();
  let total = 0;
  let caret = 0;
  const events: LoginEvents = {
    onValues: (email, passwordLength) => {
      const typed = email.length + passwordLength;
      if (typed !== total) pond.typed(caret);
      total = typed;
    },
    onCaret: (position) => {
      caret = position;
    },
    onEmailFocus: () => pond.setMood("watching"),
    onPasswordFocus: (shown) => pond.setMood(shown ? "peeking" : "hiding"),
    onReveal: (shown) => pond.setMood(shown ? "peeking" : "hiding"),
    onLeave: () => pond.setMood("idle"),
    onStatus: (status) => {
      if (status === "ok") pond.setMood("happy");
      if (status === "wrong") pond.setMood("startled");
    },
  };
  return { pond, events };
}

export default function Login() {
  const [{ pond, events }] = useState(createPond);

  return (
    <Shell scene={pond}>
      <h1 className={titleClass}>
        <Reveal>Welcome back</Reveal>
      </h1>
      <p className="mt-2 mb-7 text-[15px] text-ink-soft">The koi dive while you type your password.</p>
      <LoginForm {...events} />
    </Shell>
  );
}
