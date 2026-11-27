"use client";

import { Fragment, useEffect, useState } from "react";
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
  const [showAll, setShowAll] = useState(false);

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

  async function signOutOthers() {
    if (!sessions || busy) return;
    setSigningOut(true);
    try {
      await Promise.all(sessions.filter((session) => !session.current).map((session) => revokeSession(session.id)));
      setSessions((items) => items?.filter((session) => session.current));
      toast.success("Other devices have been signed out.");
    } catch (cause) {
      toast.error(toastFor(cause));
    } finally {
      setSigningOut(false);
    }
  }

  const busy = busyId !== undefined || signingOut;
  const olderSessions = sessions?.filter((item) => now - Date.parse(item.lastSeenAt) > 7 * 24 * 60 * 60 * 1000) ?? [];
  const recentSessions = sessions?.filter((item) => now - Date.parse(item.lastSeenAt) <= 7 * 24 * 60 * 60 * 1000) ?? [];
  const displayedSessions = showAll ? [...recentSessions, ...olderSessions] : recentSessions.slice(0, 5);

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
        <>
        <ul aria-label="Devices signed in to your account" className="border-b border-rule">
          {displayedSessions.map((session, index) => {
            const label = describeDevice(session.userAgent);
            return (
              <Fragment key={session.id}>
              {showAll && olderSessions.length > 0 && index === recentSessions.length && <li className="border-t border-rule py-3 font-mono text-[11px] tracking-[.12em] text-ink-muted uppercase">Older · last active over 7 days ago</li>}
              <li className="grid gap-3 border-t border-rule py-5 sm:grid-cols-[1fr_auto] sm:items-center">
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
              </Fragment>
            );
          })}
        </ul>
        {sessions.length>5&&<Button type="button" variant="link" size="sm" aria-expanded={showAll} onClick={()=>setShowAll(value=>!value)}>{showAll?"Show fewer":`Show all (${sessions.length})`}</Button>}
        </>
      )}

      <Feedback message={notice} />

      <div>
        <Button type="button" variant="secondary" size="lg" loading={signingOut} disabled={busy || !sessions?.some((session) => !session.current)} onClick={() => void signOutOthers()}>
          Sign out of other devices
        </Button>
      </div>
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
