"use client";

import { useState } from "react";
import { AuthHeader } from "../auth-header";
import { ForgotForm } from "../forms/forgot-form";
import { PaperPlane } from "./paper-plane";
import { PaperPlaneCanvas } from "./paper-plane-canvas";


export default function Forgot() {
  const [plane] = useState(() => new PaperPlane());

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="03" section="Recovery" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* The plane is white paper on vermilion in both modes. */}
        <section data-theme="light" className="relative min-h-[44dvh] overflow-hidden bg-vermilion">
          <PaperPlaneCanvas plane={plane} className="absolute inset-0" />
        </section>

        <section className="flex flex-col justify-center px-5 py-10 md:px-10 lg:px-14">
          <ForgotForm
            onType={(length, valid) => plane.typed(length, valid)}
            onSent={(sent) => plane.setSent(sent)}
            onError={() => plane.rejected()}
          />
        </section>
      </div>
    </main>
  );
}
