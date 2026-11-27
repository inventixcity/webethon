"use client";

import { useState, type FormEvent } from "react";
import { Field } from "@/components/auth/field";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { createWebhook, type CreatedWebhook } from "@/features/webhooks/client";
import { eventGroups, type EntityOption } from "@/features/webhooks/events";
import { webhookToast } from "@/features/webhooks/errors";
import { formFailure } from "@/features/data/errors";
import { EventPicker } from "./event-picker";

const FIELDS = ["url", "description", "events"] as const;

type WebhookFormProps = {
  entities: EntityOption[];
  onCreated: (webhook: CreatedWebhook) => void;
  onCancel: () => void;
};

/** A new webhook. The secret comes back once, in the response, and the parent shows it before anything else. */
export function WebhookForm({ entities, onCreated, onCancel }: WebhookFormProps) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const clientErrors: Record<string, string> = {};
    if (url.trim() === "") clientErrors.url = "Enter the address that should receive the events.";
    if (events.length === 0) clientErrors.events = "Choose at least one event.";
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;

    setPending(true);
    try {
      const created = await createWebhook({
        url: url.trim(),
        events,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      });
      onCreated(created);
    } catch (cause) {
      const failure = formFailure(cause, FIELDS);
      setErrors(failure.named);
      if (failure.toast) toast.error(webhookToast(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-8 border border-rule bg-paper-raised p-5 md:p-8">
      <div className="grid gap-2">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">New webhook</p>
        <p className="text-ink-soft">We send a signed POST request to this address each time a chosen event happens.</p>
      </div>

      <Field
        label="Address"
        name="url"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://example.com/hooks/records"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        error={errors.url}
        disabled={pending}
      />

      <Field
        label="Description (optional)"
        name="description"
        autoComplete="off"
        placeholder="What this endpoint does"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        error={errors.description}
        disabled={pending}
      />

      <EventPicker
        groups={eventGroups(entities)}
        selected={events}
        onChange={setEvents}
        disabled={pending}
        error={errors.events}
      />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" loading={pending} disabled={pending}>
          {pending ? "Creating" : "Create webhook"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
