import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { siteConfig } from "@/config/site";
import { DemoAccounts } from "./demo-accounts";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return (
    <>
      <AuthScreen set={siteConfig.authSet} screen="login" />
      <DemoAccounts />
    </>
  );
}
