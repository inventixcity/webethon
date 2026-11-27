"use client";

import { useState } from "react";
import { ShaderCanvas } from "@/components/canvas/shader-canvas";
import { Reveal } from "@/components/motion/reveal";
import { type LoginEvents, LoginForm } from "../forms/login-form";
import { Aurora } from "./aurora";
import { Shell } from "./shell";

const RESTING = 0.5;
const WATCHING = 0.72;
const LOW = 0.08;

function createAurora() {
  const aurora = new Aurora(RESTING);
  let total = 0;
  let caret = 0;
  const events: LoginEvents = {
    onValues: (email, passwordLength) => {
      const typed = email.length + passwordLength;
      // Each keystroke lights the sky at the point the caret has reached.
      if (typed !== total) aurora.pulse(0.1 + caret * 0.8);
      total = typed;
    },
    onCaret: (position) => {
      caret = position;
    },
    onEmailFocus: () => aurora.rise(WATCHING),
    onPasswordFocus: (shown) => aurora.rise(shown ? RESTING : LOW),
    onReveal: (shown) => aurora.rise(shown ? RESTING : LOW),
    onLeave: () => aurora.rise(RESTING),
    onStatus: (status) => {
      if (status === "ok") aurora.rise(1);
      if (status === "wrong") aurora.rise(LOW);
    },
  };
  return { aurora, events };
}

export default function Login() {
  const [{ aurora, events }] = useState(createAurora);

  return (
    <Shell
      sky={
        <div className="absolute inset-0">
          <ShaderCanvas scene={aurora} />
        </div>
      }
      title={<Reveal>Welcome back</Reveal>}
      note="The sky lights up as you type, and goes dark for your password."
    >
      <LoginForm layout="strip" {...events} />
    </Shell>
  );
}
