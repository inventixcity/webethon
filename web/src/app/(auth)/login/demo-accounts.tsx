"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Seeded accounts, one per role. Shown on the sign-in page so each role can be tried. */
const DEMO_PASSWORD = "Invigil#Demo2026";

const ACCOUNTS = [
  { role: "Admin", email: "admin@invigil.app", summary: "Users, roles and the audit log." },
  { role: "Examiner", email: "examiner@invigil.app", summary: "Author, run, grade and publish exams." },
  { role: "Candidate", email: "candidate@invigil.app", summary: "Take exams and read published results." },
] as const;

/**
 * Writes a value into a controlled input the way a person typing would. React only notices a change when the
 * native setter is used, so the form's own onChange handlers receive it.
 */
function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Fills the existing sign-in form and submits it through the form's normal handler, so validation and the
 * sign-in request are exactly the same as typing the details by hand. Nothing is sent unless a button is pressed.
 */
export function DemoAccounts() {
  const [message, setMessage] = useState<string>();

  function signInAs(email: string) {
    const emailInput = document.querySelector<HTMLInputElement>('input[name="email"]');
    const passwordInput = document.querySelector<HTMLInputElement>('input[name="password"]');
    const form = emailInput?.form ?? passwordInput?.form;
    if (!emailInput || !passwordInput || !form) {
      setMessage("The sign-in form is still loading. Try again in a moment.");
      return;
    }
    setMessage(undefined);
    typeInto(emailInput, email);
    typeInto(passwordInput, DEMO_PASSWORD);
    form.requestSubmit();
  }

  return (
    <section aria-labelledby="demo-accounts" className="border-t border-ink px-5 py-10 md:px-8">
      <div className="mx-auto grid w-full max-w-6xl gap-8">
        <div className="grid gap-3">
          <h2 id="demo-accounts" className="font-mono text-[11px] tracking-[0.14em] uppercase">
            Demo accounts
          </h2>
          <p className="max-w-[62ch] text-base text-ink-soft">
            Each button fills the form with a demo account and signs in. Password for all three:{" "}
            <span className="font-mono text-[13px] tracking-normal text-ink">{DEMO_PASSWORD}</span>
          </p>
        </div>

        <ul className="grid gap-px border-y border-rule md:grid-cols-3">
          {ACCOUNTS.map((account) => (
            <li key={account.role} className="grid content-start gap-4 py-6 md:px-6 md:first:pl-0 md:last:pr-0">
              <div className="grid gap-1">
                <span className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{account.role}</span>
                <span className="font-mono text-sm break-all">{account.email}</span>
                <span className="text-sm text-ink-soft">{account.summary}</span>
              </div>
              <Button type="button" variant="secondary" className="w-full" onClick={() => signInAs(account.email)}>
                Sign in as {account.role}
              </Button>
            </li>
          ))}
        </ul>

        <div aria-live="polite" className="min-h-4 font-mono text-[11px] tracking-wide">
          {message && (
            <p className="flex items-center gap-2">
              <span aria-hidden="true" className="size-1.5 shrink-0 bg-vermilion" />
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
