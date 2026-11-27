"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { listSessions, revokeSession, signOutEverywhere } from "../client";
import { messageFor, toastFor } from "../errors";
import { describeDevice, formatLastActive } from "../device";
import type { Session } from "../types";
import { Feedback } from "./feedback";

type DevicesListProps = {
  /** Change this to reload the list, for example after the password was changed elsewhere in the page. */
  reloadKey: number;
};

/** This device first, then the rest by most recently active. */
function sortSessions(items: Session[]): Session[] {
  return [...items].sort(
    (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
  );
}

export function DevicesList({ reloadKey }: DevicesListProps) {
  const toast = useToast();
  const [sessions, setSessions] = useState<Session[]>();
  // Read once per load, so the relative times are computed against the clock at that moment.
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;

    listSessions()
      .then((items) => {
        if (!active) return;
        setSessions(sortSessions(items));
        setNow(Date.now());
        setLoadError(undefined);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(messageFor(cause));
      });

    return () => {
      active = false;
    };
  }, [reloadKey, attempt]);

  async function revoke(session: Session) {
    const label = describeDevice(session.userAgent);
    setBusyId(session.id);
    setNotice(undefined);

    try {
      await revokeSession(session.id);
      setSessions((items) => items?.filter((item) => item.id !== session.id));
      setNotice(`${label} has been signed out.`);
    } catch (cause) {
      toast.error(toastFor(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  async function signOutAll() {
    setSigningOut(true);
    setNotice(undefined);

    try {
      await signOutEverywhere();
    } catch (cause) {
      toast.error(toastFor(cause));
      setSigningOut(false);
      return;
    }
    // Every session is gone, so the sign-in page is the next stop. The button stays busy until the page changes.
    window.location.assign("/login");
  }

  const busy = busyId !== undefined || signingOut;

  return (
    <div className="grid max-w-xl gap-6">
      {loadError ? (
        <div className="grid justify-items-start gap-4">
          <Feedback message={loadError} tone="error" />
          <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      ) : sessions === undefined ? (
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Loading devices</p>
      ) : (
        <ul aria-label="Devices signed in to your account" className="border-b border-rule">
          {sessions.map((session) => {
            const label = describeDevice(session.userAgent);
            return (
              <li
                key={session.id}
                className="grid gap-3 border-t border-rule py-5 sm:grid-cols-[1fr_auto] sm:items-center"
              >
                <div className="grid min-w-0 gap-1.5">
                  <p className="text-lg font-medium break-words">{label}</p>
                  <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
                    {formatLastActive(session.lastSeenAt, now)}
                  </p>
                </div>

                {session.current ? (
                  <span className="justify-self-start border border-ink px-2.5 py-1 font-mono text-[11px] tracking-[0.12em] uppercase sm:justify-self-end">
                    This device
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={busyId === session.id}
                    disabled={busy}
                    aria-label={`Revoke ${label}`}
                    onClick={() => void revoke(session)}
                    className="justify-self-start sm:justify-self-end"
                  >
                    {busyId === session.id ? "Revoking" : "Revoke"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Feedback message={notice} />

      <div>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          loading={signingOut}
          disabled={busy}
          onClick={() => void signOutAll()}
        >
          {signingOut ? "Signing out everywhere" : "Sign out of every device"}
        </Button>
      </div>
    </div>
  );
}
