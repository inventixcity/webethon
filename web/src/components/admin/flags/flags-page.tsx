"use client";

import { CircleCheck, CircleDashed } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeading, Status } from "@/components/admin/workspace";
import { formatDateTime } from "@/components/admin/jobs/format";
import { Button } from "@/components/ui/button";
import { listAdminFlags, type AdminFlag } from "@/features/flags/client";
import { useFlags } from "@/lib/flags";
import { FlagEditor } from "./flag-editor";

/** The editor is open for an existing flag, for a new one, or not at all. */
type Editing = AdminFlag | "new" | null;

export function FlagsPage() {
  const { refresh: refreshAppFlags } = useFlags();
  const [flags, setFlags] = useState<AdminFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    listAdminFlags()
      .then((rows) => {
        if (live) setFlags(rows);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [version]);

  // The list is not paged, so it is sorted by key here to keep the order steady after each save.
  const sorted = [...flags].sort((a, b) => a.key.localeCompare(b.key));

  function saved() {
    setEditing(null);
    setVersion((value) => value + 1);
    // The change may affect this tab's own view of the flags, so re-read them for the app too.
    refreshAppFlags();
  }

  return (
    <>
      <PageHeading
        title="Flags"
        description="Turn features on or off, roll them out to a share of viewers, or allow specific people and teams."
      />

      <div className="mb-6 flex justify-end">
        <Button size="sm" onClick={() => setEditing("new")}>
          New flag
        </Button>
      </div>

      <Status loading={loading} error={error} onRetry={() => setVersion((value) => value + 1)} />
      {!loading && !error && sorted.length === 0 && (
        <p className="border border-rule p-6 text-ink-muted">No flags yet. Create one to start a rollout.</p>
      )}
      {!loading && !error && sorted.length > 0 && <FlagTable flags={sorted} onOpen={(flag) => setEditing(flag)} />}

      {editing !== null && (
        <FlagEditor
          key={editing === "new" ? "new" : editing.key}
          flag={editing === "new" ? null : editing}
          takenKeys={flags.map((flag) => flag.key)}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}

function FlagTable({ flags, onOpen }: { flags: AdminFlag[]; onOpen: (flag: AdminFlag) => void }) {
  const headings = ["Key", "Description", "Enabled", "Rollout", "Updated", "Details"];
  return (
    <div className="overflow-x-auto border border-rule">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-paper-sunk">
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading} className="px-4 py-3 font-semibold">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <tr
              key={flag.key}
              className="cursor-pointer border-t border-rule hover:bg-paper-sunk"
              onClick={() => onOpen(flag)}
            >
              <td className="max-w-56 px-4 py-3 align-top font-mono text-xs break-all">{flag.key}</td>
              <td className="max-w-72 px-4 py-3 align-top break-words text-ink-soft">{flag.description || "None"}</td>
              <td className="px-4 py-3 align-top">
                <EnabledLabel enabled={flag.enabled} />
              </td>
              <td className="px-4 py-3 align-top tabular-nums">{flag.rollout}%</td>
              <td className="px-4 py-3 align-top whitespace-nowrap">{formatDateTime(flag.updatedAt)}</td>
              <td className="px-4 py-3 align-top">
                <Button
                  variant="link"
                  onClick={(event) => {
                    // The row opens the editor too; stop the click from doing it twice.
                    event.stopPropagation();
                    onOpen(flag);
                  }}
                >
                  Edit<span className="sr-only"> flag {flag.key}</span>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A text label with its own shape, so the state is never shown by colour alone. */
function EnabledLabel({ enabled }: { enabled: boolean }) {
  const Icon = enabled ? CircleCheck : CircleDashed;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {enabled ? "On" : "Off"}
    </span>
  );
}
