import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AccountSettings } from "@/features/account/components/account-settings";
import { SettingsCard } from "@/features/account/components/settings-card";
import { getProfile } from "@/features/account/server";
import { requireUser } from "@/features/auth/require-user";
import { ManageLinks } from "@/components/shares/manage-links";
import { WebhooksPanel } from "@/components/webhooks/webhooks-panel";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

/** Account settings. The shell reads the profile on the server; each section is a client component. */
export default async function SettingsPage() {
  // Redirects to sign-in when there's no session. The layout checks too, so this is a cheap second look.
  await requireUser();
  const profile = await getProfile();

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-12 px-5 py-10 md:px-8 md:py-16">
        <section className="grid gap-6">
          <Link
            href="/app"
            className="inline-flex w-fit items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase transition-colors duration-(--duration-fast) hover:text-vermilion-deep"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Home
          </Link>
          <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            <span aria-hidden="true" className="size-1.5 bg-vermilion" />
            01 / Account
          </p>
          <h1 className="text-[clamp(2.25rem,5vw,4rem)] leading-[1.02] font-medium tracking-[-0.035em]">Settings.</h1>
        </section>

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
