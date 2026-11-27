"use client";

import { useEffect, useState } from "react";
import { ConfirmAction } from "@/components/teams/confirm-action";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  deleteWebhook,
  listDeliveries,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type LastDelivery,
  type Webhook,
} from "@/features/webhooks/client";
import { ALL_EVENTS, eventGroups, type EntityOption } from "@/features/webhooks/events";
import { webhookToast } from "@/features/webhooks/errors";
import { deliveryStatusLabel, formatDateTime, isFailedStatus } from "@/features/webhooks/format";
import { formFailure } from "@/features/data/errors";
import { cn } from "@/lib/utils";
import { EventPicker } from "./event-picker";
import { SecretPanel } from "./secret-panel";
import { WebhookDeliveries } from "./webhook-deliveries";

const EDIT_FIELDS = ["events", "active"] as const;

type WebhookRowProps = {
  webhook: Webhook;
  entities: EntityOption[];
  onChanged: (webhook: Webhook) => void;
  onDeleted: (id: string) => void;
};

type Busy = "save" | "rotate" | "test" | "delete" | undefined;

/** One webhook: its address and state, then the actions that change it. */
export function WebhookRow({ webhook, entities, onChanged, onDeleted }: WebhookRowProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>();
  const [editing, setEditing] = useState(false);
  const [draftEvents, setDraftEvents] = useState<string[]>(webhook.events);
  const [draftActive, setDraftActive] = useState(webhook.active);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [showDeliveries, setShowDeliveries] = useState(false);
  // The rotated secret is kept only here, and only until the person dismisses it.
  const [secret, setSecret] = useState<string>();
  // The newest delivery, read from the deliveries endpoint: the list response does not carry it.
  // "unavailable" when that read fails; the row still works without it.
  const [latest, setLatest] = useState<LastDelivery | null | "unavailable">();
  const [latestKey, setLatestKey] = useState(0);
  const serverHasLast = webhook.lastDelivery !== undefined;

  useEffect(() => {
    if (serverHasLast) return;
    let active = true;
    listDeliveries(webhook.id, 1)
      .then((rows) => {
        if (!active) return;
        const newest = rows[0];
        setLatest(newest ? { status: newest.status, responseCode: newest.responseCode, at: newest.createdAt } : null);
      })
      .catch(() => {
        if (active) setLatest("unavailable");
      });
    return () => {
      active = false;
    };
  }, [webhook.id, serverHasLast, latestKey]);

  function startEditing() {
    setDraftEvents(webhook.events);
    setDraftActive(webhook.active);
    setDraftErrors({});
    setEditing(true);
  }

  async function save() {
    if (draftEvents.length === 0) {
      setDraftErrors({ events: "Choose at least one event." });
      return;
    }
    setBusy("save");
    setDraftErrors({});
    try {
      const updated = await updateWebhook(webhook.id, { events: draftEvents, active: draftActive });
      onChanged(updated);
      setEditing(false);
      toast.success("Webhook saved.");
    } catch (cause) {
      const failure = formFailure(cause, EDIT_FIELDS);
      setDraftErrors(failure.named);
      if (failure.toast) toast.error(webhookToast(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function rotate() {
    setBusy("rotate");
    try {
      const rotated = await rotateWebhookSecret(webhook.id);
      setSecret(rotated.secret);
    } catch (cause) {
      toast.error(webhookToast(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      const result = await testWebhook(webhook.id);
      const failed = result?.status !== undefined && isFailedStatus(result.status);
      const code = typeof result?.responseCode === "number" ? result.responseCode : undefined;
      if (failed) {
        toast.error(
          code === undefined
            ? "The test didn't reach your endpoint. Check the address and try again."
            : `The test got a ${code} response, so it didn't count as delivered.`,
        );
      } else {
        toast.success(
          code === undefined
            ? "Test sent. Check the deliveries for the result."
            : `Test delivered. Your endpoint answered ${code}.`,
        );
      }
    } catch (cause) {
      toast.error(webhookToast(cause));
    } finally {
      setBusy(undefined);
      setLatestKey((count) => count + 1);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await deleteWebhook(webhook.id);
      onDeleted(webhook.id);
    } catch (cause) {
      toast.error(webhookToast(cause));
      setBusy(undefined);
    }
  }

  const eventCount = webhook.events.includes(ALL_EVENTS) ? "All events" : `${webhook.events.length} ${webhook.events.length === 1 ? "event" : "events"}`;
  const last = webhook.lastDelivery ?? (typeof latest === "object" ? latest : null);
  const lastText =
    last === null || last === undefined
      ? latest === "unavailable"
        ? "Not available right now"
        : latest === undefined && !serverHasLast
          ? "Checking"
          : "No deliveries yet"
      : `${deliveryStatusLabel(last.status)}${last.responseCode === null ? "" : `, ${last.responseCode}`}, ${formatDateTime(last.at)}`;

  return (
    <li className="grid gap-6 border-t border-rule py-6">
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
        <div className="grid min-w-0 gap-2">
          <p className="font-medium break-all">{webhook.url}</p>
          {webhook.description ? <p className="text-ink-soft">{webhook.description}</p> : null}
          <dl className="grid gap-x-8 gap-y-2 font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase sm:grid-cols-3">
            <div>
              <dt className="inline">State: </dt>
              <dd className={cn("inline", webhook.active ? "text-ink" : "text-vermilion-deep")}>
                {webhook.active ? "Active" : "Paused"}
              </dd>
            </div>
            <div>
              <dt className="inline">Events: </dt>
              <dd className="inline text-ink">{eventCount}</dd>
            </div>
            <div>
              <dt className="inline">Last delivery: </dt>
              <dd className="inline normal-case tracking-normal text-ink">{lastText}</dd>
            </div>
          </dl>
        </div>
      </div>

      {secret !== undefined ? (
        <SecretPanel
          title={`New signing secret for ${webhook.url}`}
          secret={secret}
          onDone={() => setSecret(undefined)}
        />
      ) : null}

      {editing ? (
        <div className="grid gap-8 border border-rule bg-paper-raised p-5 md:p-6">
          <EventPicker
            groups={eventGroups(entities)}
            selected={draftEvents}
            onChange={setDraftEvents}
            disabled={busy === "save"}
            error={draftErrors.events}
          />
          <div className="flex items-start gap-3">
            <Checkbox
              id={`webhook-${webhook.id}-active`}
              checked={draftActive}
              disabled={busy === "save"}
              onCheckedChange={(state) => setDraftActive(state === true)}
              className="mt-0.5"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={`webhook-${webhook.id}-active`} className="cursor-pointer text-[12px] normal-case tracking-normal font-medium">
                Active
              </Label>
              <span className="text-sm text-ink-muted">Deliveries are sent while this is on.</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" size="sm" loading={busy === "save"} disabled={busy === "save"} onClick={save}>
              {busy === "save" ? "Saving" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy === "save"} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {!editing ? (
          <Button type="button" variant="secondary" size="sm" onClick={startEditing} disabled={busy !== undefined}>
            Edit events
          </Button>
        ) : null}
        <Button type="button" variant="secondary" size="sm" loading={busy === "test"} disabled={busy !== undefined} onClick={sendTest}>
          {busy === "test" ? "Sending" : "Send test"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={showDeliveries}
          onClick={() => setShowDeliveries((open) => !open)}
        >
          {showDeliveries ? "Hide deliveries" : "View deliveries"}
        </Button>
        <ConfirmAction
          label="Rotate secret"
          question="Rotate it? The current secret stops working right away."
          confirmLabel="Rotate secret"
          pending={busy === "rotate"}
          disabled={busy !== undefined}
          onConfirm={rotate}
        />
        <ConfirmAction
          label="Delete"
          question="Delete this webhook? Deliveries stop, and this can't be undone."
          confirmLabel="Delete webhook"
          tone="danger"
          pending={busy === "delete"}
          disabled={busy !== undefined && busy !== "delete"}
          onConfirm={remove}
        />
      </div>

      {showDeliveries ? <WebhookDeliveries webhookId={webhook.id} /> : null}
    </li>
  );
}
