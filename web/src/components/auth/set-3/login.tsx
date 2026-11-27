"use client";

import { useCallback, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { AuthHeader } from "../auth-header";
import { LoginForm, type LoginStatus } from "../forms/login-form";
import { FlapBoard, type FlapRow } from "./flap-board";

const COLUMNS = 20;

function statusRow(status: LoginStatus | undefined, email: string, secretLength: number): FlapRow {
  if (status === "pending") return { text: "CHECKING PAPERS" };
  if (status === "ok") return { text: "WELCOME ABOARD", accent: true };
  if (status === "wrong") return { text: "ACCESS DENIED", accent: true };
  if (email && secretLength > 0) return { text: "READY TO BOARD" };
  if (email) return { text: "AWAITING KEY" };
  return { text: "WAITING AT GATE" };
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [secretLength, setSecretLength] = useState(0);
  const [status, setStatus] = useState<LoginStatus>();

  const onValues = useCallback((value: string, length: number) => {
    setEmail(value);
    setSecretLength(length);
    setStatus(undefined);
  }, []);

  const rows: FlapRow[] = [
    { text: "ARRIVALS     GATE 01" },
    { text: email || "ENTER YOUR EMAIL" },
    { text: secretLength ? "*".repeat(secretLength) : "ENTER YOUR KEY" },
    statusRow(status, email, secretLength),
  ];

  return (
    <main className="flex min-h-dvh flex-col">
      <AuthHeader index="01" section="Access" />

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="flex flex-col justify-center px-5 py-10 md:px-10 xl:px-16">
          <div className="mx-auto w-full max-w-md">
            <h1 className="text-[clamp(2.5rem,4vw,3.75rem)] leading-none font-semibold tracking-[-0.03em]">
              <Reveal>Welcome back.</Reveal>
            </h1>
            <p className="mt-3 mb-9 text-base text-ink-soft">Your arrival is going up on the board.</p>
            <LoginForm onValues={onValues} onStatus={setStatus} />
          </div>
        </section>

        {/* The board is dark in both modes, like the real thing. */}
        <section
          data-theme="dark"
          className="flex flex-col justify-center gap-4 border-rule bg-paper p-5 text-ink md:p-10 lg:border-l xl:p-14"
        >
          <p className="flex justify-between font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            <span>Arrivals</span>
            <span>All gates</span>
          </p>
          <FlapBoard rows={rows} columns={COLUMNS} />
        </section>
      </div>
    </main>
  );
}
