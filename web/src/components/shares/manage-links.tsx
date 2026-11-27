"use client";

import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/teams/confirm-action";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { listEntities } from "@/features/data/client";
import { formatDate } from "@/features/webhooks/format";
import { listShares, revokeShare, type Share } from "@/features/shares/client";
import { describeError } from "@/lib/errors";

/** The signed-in person's public share links, with revoke. Creating a link happens on the record itself. */
export function ManageLinks() {
  const toast = useToast();
  const [shares, setShares] = useState<Share[]>();
  const [entityLabels, setEntityLabels] = useState<Record<string, string>>({});
  // Read once per load, so "expired" is judged against the clock at that moment.
  const [loadedAt, setLoadedAt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoadFailed(false);

    listShares()
      .then((items) => {
        if (!active) return;
        setShares(items);
        setLoadedAt(Date.now());
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        toast.error(describeError(cause));
      });

    // Entity labels are for reading only. Without them the entity's internal name is shown instead.
    listEntities()
      .then((items) => {
        if (active) setEntityLabels(Object.fromEntries(items.map((entity) => [entity.name, entity.label])));
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
    // The toast handle is stable for the provider's lifetime, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function revoke(share: Share) {
    setBusyId(share.id);
    try {
      await revokeShare(share.id);
      setShares((items) => items?.filter((item) => item.id !== share.id));
      toast.success("Link revoked. It no longer opens.");
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  if (loadFailed) {
    return (
      <div className="grid justify-items-start gap-4">
        <p className="text-ink-soft">Your share links couldn&apos;t be loaded.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (shares === undefined) {
    return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Loading links</p>;
  }

  if (shares.length === 0) {
    return (
      <p className="text-ink-soft">
        You haven&apos;t shared any records yet. Open a record and choose Share to make a public link.
      </p>
    );
  }

  return (
    <ul aria-label="Your share links" className="border-b border-rule">
      {shares.map((share) => {
        const expired = loadedAt > 0 && Date.parse(share.expiresAt) <= loadedAt;
        const inactive = Boolean(share.revokedAt) || expired;
        const entity = entityLabels[share.entity] ?? share.entity;
        return (
          <li key={share.id} className="grid gap-4 border-t border-rule py-5 md:grid-cols-[1fr_auto] md:items-center">
            <div className="grid min-w-0 gap-2">
              <p className="font-medium">{entity}</p>
              <dl className="flex flex-wrap gap-x-8 gap-y-1 font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">
                <div>
                  <dt className="inline">Created: </dt>
                  <dd className="inline normal-case tracking-normal text-ink">{formatDate(share.createdAt)}</dd>
                </div>
                <div>
                  <dt className="inline">Expires: </dt>
                  <dd className="inline normal-case tracking-normal text-ink">
                    {share.revokedAt ? "Revoked" : expired ? "Expired" : formatDate(share.expiresAt)}
                  </dd>
                </div>
              </dl>
            </div>

            {inactive ? null : (
              <ConfirmAction
                label="Revoke"
                question="Revoke this link? Anyone with it will see the page gone right away."
                confirmLabel="Revoke link"
                tone="danger"
                pending={busyId === share.id}
                disabled={busyId !== undefined && busyId !== share.id}
                onConfirm={() => revoke(share)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
