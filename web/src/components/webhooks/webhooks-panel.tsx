"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { listEntities } from "@/features/data/client";
import { listWebhooks, type CreatedWebhook, type Webhook } from "@/features/webhooks/client";
import type { EntityOption } from "@/features/webhooks/events";
import { webhookToast } from "@/features/webhooks/errors";
import { SecretPanel } from "./secret-panel";
import { WebhookForm } from "./webhook-form";
import { WebhookRow } from "./webhook-row";

/** The webhooks section of settings: the list, the add form, and the one-time secret after a create. */
export function WebhooksPanel() {
  const toast = useToast();
  const [webhooks, setWebhooks] = useState<Webhook[]>();
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  // Holds the secret from the last create, until the person dismisses it. Never stored anywhere else.
  const [created, setCreated] = useState<CreatedWebhook>();

  useEffect(() => {
    let active = true;
    setLoadFailed(false);

    listWebhooks()
      .then((items) => {
        if (active) setWebhooks(items);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        toast.error(webhookToast(cause));
      });

    listEntities()
      .then((items) => {
        if (active) setEntities(items.map((entity) => ({ name: entity.name, label: entity.label })));
      })
      .catch((cause: unknown) => {
        // The record events are missing without entities, but the list and the rest still work.
        if (active) toast.error(webhookToast(cause));
      });

    return () => {
      active = false;
    };
    // The toast handle is stable for the provider's lifetime, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  function handleCreated(result: CreatedWebhook) {
    // The list gets the webhook without its secret. The secret is kept only for the panel.
    const { secret: _secret, ...webhook } = result;
    setWebhooks((items) => [webhook, ...(items ?? [])]);
    setCreated(result);
    setAdding(false);
    toast.success("Webhook created. Copy its signing secret now.");
  }

  return (
    <div className="grid gap-8">
      {created ? (
        <SecretPanel
          title={`Signing secret for ${created.url}`}
          secret={created.secret}
          onDone={() => setCreated(undefined)}
        />
      ) : null}

      {adding ? (
        <WebhookForm entities={entities} onCreated={handleCreated} onCancel={() => setAdding(false)} />
      ) : (
        <div>
          <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
            Add webhook
          </Button>
        </div>
      )}

      {loadFailed ? (
        <div className="grid justify-items-start gap-4">
          <p className="text-ink-soft">Your webhooks couldn&apos;t be loaded.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </div>
      ) : webhooks === undefined ? (
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Loading webhooks</p>
      ) : webhooks.length === 0 ? (
        <p className="text-ink-soft">
          No webhooks yet. Add one to have your own server receive signed events as they happen.
        </p>
      ) : (
        <ul aria-label="Your webhooks" className="border-b border-rule">
          {webhooks.map((webhook) => (
            <WebhookRow
              key={webhook.id}
              webhook={webhook}
              entities={entities}
              onChanged={(updated) =>
                setWebhooks((items) => items?.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
              }
              onDeleted={(id) => setWebhooks((items) => items?.filter((item) => item.id !== id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
