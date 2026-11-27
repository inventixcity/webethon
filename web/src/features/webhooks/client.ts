/**
 * Webhook calls through the same-origin /api/v1 proxy. Every function throws an ApiError on failure.
 *
 * Secrets (`whsec_...`) come back once, from create and rotate. Callers keep them in component state only:
 * never in localStorage, never in logs.
 */
import { api } from "@/lib/api/client";

export type DeliveryStatus = "succeeded" | "failed" | "pending" | "retrying" | "dead" | (string & {});

export type LastDelivery = {
  status: DeliveryStatus;
  responseCode: number | null;
  at: string;
};

export type Webhook = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  /** Set while deliveries have been failing. The auto-disable happens after a few days of this. */
  failureSince?: string | null;
  createdAt: string;
  /** Not in the list response; filled in by the row from GET deliveries (limit 1) when the API doesn't send it. */
  lastDelivery?: LastDelivery | null;
};

/** Returned once, by POST /webhooks. */
export type CreatedWebhook = Webhook & { secret: string };

/** The create response as the API sends it: the webhook and its secret side by side. */
type CreateWebhookResponse = { webhook: Webhook; secret: string };

export type CreateWebhookInput = {
  url: string;
  events: string[];
  description?: string;
};

export type UpdateWebhookInput = {
  events?: string[];
  active?: boolean;
  description?: string;
};

/** Returned once, by POST /webhooks/:id/rotate-secret. */
export type RotatedSecret = { secret: string };

export type WebhookTestResult = {
  status?: DeliveryStatus;
  responseCode?: number | null;
  durationMs?: number | null;
};

export type Delivery = {
  id: string;
  status: DeliveryStatus;
  responseCode: number | null;
  durationMs: number | null;
  attempt: number;
  createdAt: string;
  nextRetryAt: string | null;
};

export const listWebhooks = () => api<Webhook[]>("/webhooks");

/** Accepts the API's `{ webhook, secret }` shape, and the flat shape from the contract, so either can be sent. */
export async function createWebhook(input: CreateWebhookInput): Promise<CreatedWebhook> {
  const body = await api<CreateWebhookResponse | CreatedWebhook>("/webhooks", { body: input });
  if ("webhook" in body) return { ...body.webhook, secret: body.secret };
  return body;
}

export const updateWebhook = (id: string, patch: UpdateWebhookInput) =>
  api<Webhook>(webhookPath(id), { method: "PATCH", body: patch });

export const deleteWebhook = (id: string) => api(webhookPath(id), { method: "DELETE" });

export const rotateWebhookSecret = (id: string) =>
  api<RotatedSecret>(`${webhookPath(id)}/rotate-secret`, { method: "POST" });

export const testWebhook = (id: string) => api<WebhookTestResult | undefined>(`${webhookPath(id)}/test`, { method: "POST" });

/** The newest deliveries first. `limit` is 1..=100; the API default is 25. */
export const listDeliveries = (id: string, limit?: number) =>
  api<Delivery[]>(`${webhookPath(id)}/deliveries${limit === undefined ? "" : `?limit=${limit}`}`);

const webhookPath = (id: string): `/webhooks/${string}` => `/webhooks/${encodeURIComponent(id)}`;
