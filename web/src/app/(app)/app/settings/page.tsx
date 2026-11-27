import type { Metadata } from "next";
import { AccountSettings } from "@/features/account/components/account-settings";
import { getProfile } from "@/features/account/server";
import { requireUser } from "@/features/auth/require-user";
import { PageHeader } from "@/components/ui/page-header";
import { describeError } from "@/lib/errors/describe";
import { SettingsLoadError } from "./settings-load-error";
import { SettingsPreferences } from "@/features/account/settings-preferences";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

/** Account settings. The shell reads the profile on the server; each section is a client component. */
export default async function SettingsPage() {
  // Redirects to sign-in when there's no session. The layout checks too, so this is a cheap second look.
  await requireUser();
  let profile;
  try {
    profile = await getProfile();
  } catch (cause) {
    const view = describeError(cause, { context: "action" });
    return (
      <main className="mx-auto grid min-h-dvh w-full max-w-6xl content-start gap-8 px-5 py-8 md:px-8">
        <PageHeader index="01" eyebrow="Account" title="Settings" description="Your profile, sign-in and security." />
        <SettingsLoadError code={String(view.code ?? view.page)} requestId={view.requestId} message={view.message} />
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-12 px-5 pb-10 md:px-8 md:pb-16">
        <PageHeader
          index="01"
          eyebrow="Account"
          title="Settings"
          breadcrumb={[{ label: "Home", href: "/app" }, { label: "Settings" }]}
          description="Your profile, sign-in and security."
        />

        <SettingsPreferences role={profile.role} />
        <AccountSettings profile={profile} />
      </div>
    </main>
  );
}
