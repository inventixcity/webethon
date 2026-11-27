"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { listDeliveries, type Delivery } from "@/features/webhooks/client";
import { deliveryStatusLabel, formatDateTime, isFailedStatus } from "@/features/webhooks/format";
import { webhookToast } from "@/features/webhooks/errors";
import { cn } from "@/lib/utils";

type WebhookDeliveriesProps = {
  webhookId: string;
};

/** The last deliveries for one webhook: when, what happened, how the endpoint answered, and any retry. */
export function WebhookDeliveries({ webhookId }: WebhookDeliveriesProps) {
  const toast = useToast();
  const [rows, setRows] = useState<Delivery[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    listDeliveries(webhookId)
      .then((items) => {
        if (active) setRows(items);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        toast.error(webhookToast(cause));
      });
    return () => {
      active = false;
    };
    // The toast handle is stable for the provider's lifetime, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhookId, attempt]);

  if (loadFailed) {
    return (
      <div className="grid justify-items-start gap-4">
        <p className="text-ink-soft">The deliveries couldn&apos;t be loaded.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (rows === undefined) {
    return <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Loading deliveries</p>;
  }

  if (rows.length === 0) {
    return <p className="text-ink-soft">No deliveries yet. Send a test, or wait for an event.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">Recent deliveries for this webhook</caption>
        <thead>
          <tr className="border-b border-rule font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
            <th scope="col" className="py-3 pr-4 font-medium">Time</th>
            <th scope="col" className="py-3 pr-4 font-medium">Status</th>
            <th scope="col" className="py-3 pr-4 font-medium">Response</th>
            <th scope="col" className="py-3 pr-4 font-medium">Duration</th>
            <th scope="col" className="py-3 pr-4 font-medium">Attempt</th>
            <th scope="col" className="py-3 font-medium">Next retry</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-rule align-top">
              <td className="py-3 pr-4 text-ink-soft">{formatDateTime(row.createdAt)}</td>
              <td className={cn("py-3 pr-4 font-medium", isFailedStatus(row.status) && "text-vermilion-deep")}>
                {deliveryStatusLabel(row.status)}
              </td>
              <td className="py-3 pr-4 font-mono">{row.responseCode ?? "No response"}</td>
              <td className="py-3 pr-4 font-mono">{row.durationMs === null ? "—" : `${row.durationMs} ms`}</td>
              <td className="py-3 pr-4 font-mono">{row.attempt}</td>
              <td className="py-3 text-ink-soft">{row.nextRetryAt ? formatDateTime(row.nextRetryAt) : "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pt-4">
        <Button type="button" variant="ghost" size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
