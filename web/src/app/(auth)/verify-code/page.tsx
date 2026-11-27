import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = { title: "Verify your email" };

type VerifyPageProps = {
  searchParams: Promise<{ email?: string; next?: string }>;
};

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const { email, next } = await searchParams;
  return <AuthScreen set={siteConfig.authSet} screen="verify" email={email} next={next} />;
}
