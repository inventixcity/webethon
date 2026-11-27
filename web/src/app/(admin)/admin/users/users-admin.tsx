"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors/describe";
import { useToast } from "@/components/feedback/toaster";
import { ConfirmDialog } from "@/components/monitor/confirm-dialog";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { hasArt } from "@/components/ui/art";
import { formatDateTime, messageOf } from "@/components/analytics/format";
import { AccessLinkReveal, resetAccessMessage, type IssuedAccessLink } from "@/components/auth/access-link";
import { useCurrentUserId } from "@/features/teams/hooks";
import { CreateAccount } from "./create-account";
import { StepUpDialog } from "./step-up-dialog";
import {
  listUsers,
  needsStepUp,
  presentRole,
  ROLE_CHOICES,
  ROLE_FILTERS,
  ROLE_LABEL,
  STATUS_FILTERS,
  toApiRole,
  type AdminUserRow,
  type UserRole,
} from "./roles";

const selectClass =
  "h-12 w-full border border-rule bg-paper-raised px-3 font-sans text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion";

type Filters = { q: string; role: string; status: string };
const EMPTY_FILTERS: Filters = { q: "", role: "", status: "" };

type UserAction = {
  title: string;
  description: string;
  path: `/${string}`;
  body?: unknown;
  tone: "primary" | "danger";
  /** Receives the reply, when the action returns something to show (the reset access link). */
  onResult?: (value: unknown) => void;
  /** Turns a failure into the message to show, when the default mapping is not clear enough. */
  explain?: (cause: unknown) => string;
};

type UserDetail = {
  sessions?: Array<{ id: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }>;
  audit?: Array<{ id: number; at: string; action: string }>;
};

const statusText = (user: AdminUserRow) =>
  user.deletedAt ? "Deleted" : user.status === "suspended" ? "Suspended" : "Active";

/** The admin's user list: search, filters, the account drawer and account creation. */
export function UsersAdmin() {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Cursor history for Previous and Next. The first page has no cursor.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const ids = useId();

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    listUsers(
      { q: filters.q.trim(), role: filters.role, status: filters.status },
      cursors[index] ?? null,
    )
      .then((page) => {
        if (!live) return;
        setRows(page.data);
        setNextCursor(page.meta.nextCursor);
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [filters, cursors, index, version]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setFilters(draft);
    setCursors([null]);
    setIndex(0);
  }

  return (
    <div className="grid gap-12">
      <PageHeader
        index="01"
        eyebrow="Administration"
        banner={hasArt("bg-users") ? "bg-users" : "bg-admin"}
        bannerCaption="FIG. 01 / USERS"
        title="Users"
        description="Create accounts and set roles. Candidates take exams, examiners run them and admins manage everyone."
      />

      <CreateAccount onCreated={() => setVersion((value) => value + 1)} />

      <section aria-labelledby={`${ids}-list`} className="grid gap-6">
        <h2 id={`${ids}-list`} className="font-mono text-[11px] tracking-[0.14em] uppercase">
          Accounts
        </h2>

        <form onSubmit={applyFilters} className="grid gap-4 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-q`}>Search by name or email</Label>
            <Input id={`${ids}-q`} type="search" value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-role`}>Role</Label>
            <select id={`${ids}-role`} className={selectClass} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
              {ROLE_FILTERS.map((value) => (
                <option key={value || "all"} value={value}>
                  {value === "" ? "All roles" : ROLE_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-status`}>Status</Label>
            <select id={`${ids}-status`} className={selectClass} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              {STATUS_FILTERS.map((value) => (
                <option key={value || "all"} value={value}>
                  {value === "" ? "All statuses" : value === "deleted" ? "Deleted" : value === "active" ? "Active" : "Suspended"}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" size="md">
            Apply filters
          </Button>
        </form>

        {loading && <BrailleSpinner label="Loading users" className="text-ink" />}
        {error && (
          <div className="grid gap-3 border border-vermilion-deep p-5">
            <p className="text-sm text-vermilion-deep">{error}</p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => setVersion((value) => value + 1)}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <p className="border border-rule p-6 text-ink-muted">No users match these filters.</p>
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            <div className="overflow-x-auto border border-rule">
              <table className="w-full min-w-[760px] text-left text-sm">
                <caption className="sr-only">User accounts with role, status and security state</caption>
                <thead className="bg-paper-sunk">
                  <tr className="font-mono text-[11px] tracking-[0.12em] uppercase">
                    <th scope="col" className="px-3 py-3 font-medium">Name and email</th>
                    <th scope="col" className="px-3 py-3 font-medium">Role</th>
                    <th scope="col" className="px-3 py-3 font-medium">Status</th>
                    <th scope="col" className="px-3 py-3 font-medium">Email verified</th>
                    <th scope="col" className="px-3 py-3 font-medium">Two-step sign-in</th>
                    <th scope="col" className="px-3 py-3 font-medium">Created</th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((user) => (
                    <tr key={user.id} className="border-t border-rule align-top">
                      <th scope="row" className="px-3 py-3 font-normal">
                        <span className="block font-medium">{user.displayName}</span>
                        <span className="block font-mono text-[11px] break-all text-ink-muted">{user.email}</span>
                      </th>
                      <td className="px-3 py-3 whitespace-nowrap">{ROLE_LABEL[presentRole(user.role) ?? "candidate"]}</td>
                      <td className="px-3 py-3 whitespace-nowrap">{statusText(user)}</td>
                      <td className="px-3 py-3 whitespace-nowrap">{user.emailVerifiedAt ? "Yes" : "No"}</td>
                      <td className="px-3 py-3 whitespace-nowrap">{user.mfa ? "On" : "Off"}</td>
                      <td className="px-3 py-3 font-mono text-xs whitespace-nowrap">{formatDateTime(user.createdAt)}</td>
                      <td className="px-3 py-3 text-right">
                        <Button variant="secondary" size="sm" onClick={() => setSelected(user)}>
                          Manage
                          <span className="sr-only"> {user.displayName}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={nextCursor === null}
                onClick={() => {
                  if (nextCursor === null) return;
                  setCursors([...cursors.slice(0, index + 1), nextCursor]);
                  setIndex(index + 1);
                }}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </section>

      {selected && (
        <UserDrawer
          key={selected.id}
          user={selected}
          onClose={() => setSelected(null)}
          onChanged={() => setVersion((value) => value + 1)}
        />
      )}
    </div>
  );
}

function UserDrawer({ user, onClose, onChanged }: { user: AdminUserRow; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [role, setRole] = useState<UserRole>(presentRole(user.role) ?? "candidate");
  const [action, setAction] = useState<UserAction | null>(null);
  const [stepUpRetry, setStepUpRetry] = useState<UserAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [issued, setIssued] = useState<IssuedAccessLink | null>(null);
  const currentUserId = useCurrentUserId();
  const titleId = useId();

  useEffect(() => {
    let live = true;
    setDetailError(null);
    api<UserDetail>(`/admin/users/${encodeURIComponent(user.id)}`)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((cause: unknown) => {
        if (live) setDetailError(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [user.id, detailVersion]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && action === null && stepUpRetry === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [action, stepUpRetry, onClose]);

  async function run(next: UserAction) {
    setBusy(true);
    try {
      const reply = await api<unknown>(next.path, { method: "POST", body: next.body });
      setAction(null);
      if (next.onResult) next.onResult(reply);
      else setNotice(`${next.title} completed for ${user.displayName}.`);
      setDetailVersion((value) => value + 1);
      onChanged();
    } catch (cause) {
      setAction(null);
      if (needsStepUp(cause)) {
        setStepUpRetry(next);
      } else {
        toast.error(next.explain ? next.explain(cause) : describeError(cause, { context: "action" }));
      }
    } finally {
      setBusy(false);
    }
  }

  const base = `/admin/users/${encodeURIComponent(user.id)}` as const;
  const actions: UserAction[] = [];
  if (role !== (presentRole(user.role) ?? "candidate")) {
    actions.push({
      title: `Change role to ${ROLE_LABEL[role]}`,
      description: "The new role applies the next time this person signs in or opens the app.",
      path: `${base}/role`,
      body: { role: toApiRole(role) },
      tone: "primary",
    });
  }
  if (!user.deletedAt && currentUserId !== undefined && currentUserId !== user.id) {
    actions.push({
      title: "Reset access",
      description:
        "Their current password stops working and every session is signed out. You get a new access link to hand over. No email is sent.",
      path: `${base}/reset-access`,
      tone: "danger",
      onResult: (reply) => {
        setIssued(reply as IssuedAccessLink);
        setNotice("");
      },
      explain: (cause) => resetAccessMessage(cause, "account"),
    });
  }
  if (!user.deletedAt) {
    actions.push(
      user.status === "suspended"
        ? { title: "Unsuspend", description: "This person can sign in again.", path: `${base}/unsuspend`, tone: "primary" }
        : { title: "Suspend", description: "This person cannot sign in until unsuspended.", path: `${base}/suspend`, tone: "danger" },
      {
        title: "Revoke sessions",
        description: "Every active session for this person is signed out.",
        path: `${base}/sessions/revoke`,
        tone: "danger",
      },
    );
    if (user.mfa) {
      actions.push({
        title: "Reset two-step sign-in",
        description: "The authenticator must be set up again on the next sign-in.",
        path: `${base}/mfa/reset`,
        tone: "danger",
      });
    }
    if (!user.emailVerifiedAt) {
      actions.push({
        title: "Resend verification",
        description: "A new verification email is sent to this address.",
        path: `${base}/verification/resend`,
        tone: "primary",
      });
    }
    actions.push({
      title: "Delete account",
      description: "The account is hidden and its sessions end. An admin can restore it later.",
      path: `${base}/delete`,
      tone: "danger",
    });
  } else {
    actions.push({ title: "Restore account", description: "The account becomes available again.", path: `${base}/restore`, tone: "primary" });
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/60" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="grid h-full w-full max-w-2xl content-start gap-8 overflow-y-auto border-l border-ink bg-paper p-5 text-ink md:p-8"
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink pb-5">
          <div className="min-w-0">
            <p className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">Account</p>
            <h2 id={titleId} className="mt-2 text-3xl leading-none font-semibold tracking-tight break-words">
              {user.displayName}
            </h2>
            <p className="mt-2 font-mono text-xs break-all text-ink-soft">{user.email}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        {notice && (
          <p role="status" className="border border-ink p-3 text-sm">
            {notice}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <div>
            <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Role</dt>
            <dd>{ROLE_LABEL[presentRole(user.role) ?? "candidate"]}</dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Status</dt>
            <dd>{statusText(user)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Created</dt>
            <dd>{formatDateTime(user.createdAt)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Email verified</dt>
            <dd>{user.emailVerifiedAt ? formatDateTime(user.emailVerifiedAt) : "Not yet"}</dd>
          </div>
        </dl>

        <section aria-labelledby={`${titleId}-activity`} className="grid gap-4">
          <h3 id={`${titleId}-activity`} className="font-mono text-[11px] tracking-[0.12em] uppercase">
            Recent activity
          </h3>
          {detailError && <p className="text-sm text-vermilion-deep">{detailError}</p>}
          {!detail && !detailError && <BrailleSpinner label="Loading activity" className="text-sm text-ink-muted" />}
          {detail && (
            <>
              <p className="text-sm text-ink-soft">
                {(detail.sessions ?? []).filter((session) => !session.revokedAt).length} active sessions
              </p>
              {(detail.audit ?? []).length === 0 ? (
                <p className="text-sm text-ink-muted">No audited actions for this account.</p>
              ) : (
                <ul className="divide-y divide-rule border-y border-rule">
                  {(detail.audit ?? []).slice(0, 10).map((entry) => (
                    <li key={entry.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                      <span className="font-mono text-xs">{entry.action}</span>
                      <time dateTime={entry.at} className="font-mono text-[11px] text-ink-muted">
                        {formatDateTime(entry.at)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {issued && (
          <AccessLinkReveal email={user.email} link={issued} onDismiss={() => setIssued(null)} />
        )}

        <section aria-labelledby={`${titleId}-actions`} className="grid gap-4">
          <h3 id={`${titleId}-actions`} className="font-mono text-[11px] tracking-[0.12em] uppercase">
            Account actions
          </h3>
          <div className="grid max-w-64 gap-2">
            <Label htmlFor={`${titleId}-role-select`}>Role</Label>
            <select
              id={`${titleId}-role-select`}
              className={selectClass}
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              {ROLE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {ROLE_LABEL[choice]}
                </option>
              ))}
            </select>
          </div>
          <div id={`${titleId}-role`} className="flex flex-wrap gap-3">
            {actions.map((item) => (
              <Button
                key={item.title}
                variant={item.tone === "danger" ? "danger" : "secondary"}
                size="sm"
                disabled={busy}
                onClick={() => setAction(item)}
              >
                {item.title}
              </Button>
            ))}
          </div>
        </section>
      </section>

      <ConfirmDialog
        open={action !== null}
        title={action?.title ?? ""}
        confirmLabel={action?.title ?? "Confirm"}
        tone={action?.tone ?? "primary"}
        busy={busy}
        onConfirm={() => action && void run(action)}
        onCancel={() => setAction(null)}
      >
        <p>
          {action?.description} This applies to <strong>{user.displayName}</strong> ({user.email}).
        </p>
        <p>The action is written to the audit log.</p>
      </ConfirmDialog>

      {stepUpRetry && (
        <StepUpDialog
          onCancel={() => setStepUpRetry(null)}
          onVerified={() => {
            const retry = stepUpRetry;
            setStepUpRetry(null);
            void run(retry);
          }}
        />
      )}
    </div>
  );
}

/** Asks for the password (and a code, when enabled) before a sensitive admin action is retried. */
