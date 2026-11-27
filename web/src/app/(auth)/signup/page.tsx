import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Open an account" };

export default function Page() {
  return <AuthScreen set={siteConfig.authSet} screen="signup" />;
}
