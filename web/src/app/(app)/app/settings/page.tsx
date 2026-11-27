import type { Metadata } from "next";
import { AccountSettings } from "@/features/account/components/account-settings";
import { SettingsCard } from "@/features/account/components/settings-card";
import { getProfile } from "@/features/account/server";
import { requireUser } from "@/features/auth/require-user";
import { ManageLinks } from "@/components/shares/manage-links";
import { WebhooksPanel } from "@/components/webhooks/webhooks-panel";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

/** Account settings. The shell reads the profile on the server; each section is a client component. */
export default async function SettingsPage() {
  // Redirects to sign-in when there's no session. The layout checks too, so this is a cheap second look.
  await requireUser();
  const profile = await getProfile();

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-12 px-5 pb-10 md:px-8 md:pb-16">
        <PageHeader
          index="01"
          eyebrow="Account"
          title="Settings"
          breadcrumb={[{ label: "Home", href: "/app" }, { label: "Settings" }]}
          description="Your profile, sign-in and security, plus the integrations and share links you manage."
        />

        <AccountSettings profile={profile} />

        <SettingsCard
          id="webhooks"
          number="06"
          eyebrow="Integrations"
          title="Webhooks"
          description="Send signed events to your own server as they happen. Each webhook gets its own secret, shown once."
        >
          <WebhooksPanel />
        </SettingsCard>

        <SettingsCard
          id="share-links"
          number="07"
          eyebrow="Sharing"
          title="Share links"
          description="Public, read-only links to records you've shared. Revoke a link to stop it working straight away."
        >
          <ManageLinks />
        </SettingsCard>
      </div>
    </main>
  );
}
