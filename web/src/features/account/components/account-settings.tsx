"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { Profile } from "../types";
import { DeleteAccountForm } from "./delete-account-form";
import { DevicesList } from "./devices-list";
import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";
import { SettingsCard } from "./settings-card";
import { MfaSettings } from "./mfa-settings";

/** The four sections of the settings page. Lives on the client so the sections can talk to each other. */
export function AccountSettings({ profile }: { profile: Profile }) {
  // Changing the password signs out every other device, so the devices list reloads when that happens.
  const [devicesVersion, setDevicesVersion] = useState(0);
  const [candidateSelfDeleteAllowed, setCandidateSelfDeleteAllowed] = useState(false);
  useEffect(() => { if (profile.role === "candidate") void api<{candidateSelfDeleteAllowed:boolean}>("/me/preferences").then((x)=>setCandidateSelfDeleteAllowed(x.candidateSelfDeleteAllowed)).catch(()=>setCandidateSelfDeleteAllowed(false)); }, [profile.role]);

  return (
    <div className="grid gap-6">
      <SettingsCard
        id="profile"
        number="01"
        eyebrow="Profile"
        title="Your details"
        description="Your name and avatar, as they appear across the app."
      >
        <ProfileForm profile={profile} />
      </SettingsCard>

      <SettingsCard
        id="password"
        number="02"
        eyebrow="Security"
        title="Password"
        description="Changing it signs out every other device."
      >
        <PasswordForm onChanged={() => setDevicesVersion((version) => version + 1)} />
      </SettingsCard>

      <SettingsCard id="two-step" number="03" eyebrow="Security" title="Two-step verification" description="Protect your account with an authenticator app.">
        <MfaSettings onChanged={() => setDevicesVersion((version) => version + 1)} />
      </SettingsCard>

      <SettingsCard
        id="devices"
        number="04"
        eyebrow="Sessions"
        title="Devices"
        description="Where your account is signed in. Revoke any device you don't recognise."
      >
        <DevicesList reloadKey={devicesVersion} />
      </SettingsCard>

      {profile.role === "candidate" && candidateSelfDeleteAllowed && <SettingsCard
        id="danger"
        number="05"
        eyebrow="Danger zone"
        title="Delete account"
        description="Removes your account and signs you out everywhere. There is no undo."
        tone="danger"
      >
        <DeleteAccountForm email={profile.email} />
      </SettingsCard>}
    </div>
  );
}
