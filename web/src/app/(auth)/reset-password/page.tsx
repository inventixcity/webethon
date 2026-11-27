import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Choose a new password" };

export default function Page() {
  return <AuthScreen set={siteConfig.authSet} screen="reset-password" />;
}
