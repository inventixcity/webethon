import type { Metadata } from "next";
import { requireUser } from "@/features/auth/require-user";
import { SignOutActions } from "./sign-out-actions";

export const metadata: Metadata = { title: "Home", robots: { index: false, follow: false } };

export default async function AppHomePage() {
  const user = await requireUser();
  const name = user.displayName.trim() || user.email;

  return (
    <main className="flex min-h-[calc(100dvh-4rem)] min-w-0 flex-col">
      <div className="grid flex-1 content-between gap-16 px-5 py-10 md:px-8 md:py-16">
        <section className="grid gap-8 md:grid-cols-12">
          <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase md:col-span-12">
            <span aria-hidden="true" className="size-1.5 bg-vermilion" />
            01 / Home
          </p>
          <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em] break-words md:col-span-10">
            Welcome back, {name}.
          </h1>
        </section>

        <dl className="grid gap-px border-y border-rule font-mono text-[11px] tracking-[0.12em] uppercase md:grid-cols-2">
          <div className="grid gap-2 py-5 md:pr-8">
            <dt className="text-ink-muted">Signed in as</dt>
            <dd className="font-sans text-lg tracking-normal normal-case break-all">{user.email}</dd>
          </div>
          <div className="grid content-start gap-2 py-5 md:pl-8">
            <dt className="text-ink-muted">Role</dt>
            <dd>
              <span className="inline-flex items-center gap-2 border border-ink px-2.5 py-1">{user.role}</span>
            </dd>
          </div>
        </dl>

        <SignOutActions />
      </div>
    </main>
  );
}
