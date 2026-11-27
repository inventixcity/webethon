import Link from "next/link";import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { siteConfig } from "@/config/site";
import { DemoAccounts } from "./demo-accounts";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  // Demo hints show only when the flag is on. Off, this is the plain institutional sign-in.
  const demoLogins = process.env.NEXT_PUBLIC_DEMO_LOGINS === "true";
  // The set 1 sign-in places the demo accounts inside its single-screen layout. Other sets keep them below.
  if (siteConfig.authSet === 1) {
    return <><AuthScreen set={1} screen="login" demo={demoLogins ? <DemoAccounts /> : undefined} /><p className="fixed inset-x-0 bottom-3 z-20 text-center text-xs text-ink-soft"><Link className="underline underline-offset-4" href="/contact">Need an account for your institute? Contact us</Link></p></>;
  }
  return (
    <>
      <AuthScreen set={siteConfig.authSet} screen="login" /><p className="py-3 text-center text-xs text-ink-soft"><Link className="underline underline-offset-4" href="/contact">Need an account for your institute? Contact us</Link></p>
      {demoLogins ? <DemoAccounts /> : null}
    </>
  );
}

