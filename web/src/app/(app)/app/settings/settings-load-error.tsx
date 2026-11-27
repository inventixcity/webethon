"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SettingsLoadError({ code, requestId, message }: { code: string; requestId?: string; message: string }) {
  const router = useRouter();
  return (
    <section role="alert" aria-labelledby="settings-load-error-title" className="grid gap-4 border border-vermilion-deep p-5">
      <div>
        <h2 id="settings-load-error-title" className="font-mono text-[11px] tracking-[0.12em] uppercase">Settings could not load</h2>
        <p className="mt-2 text-sm text-ink-soft">{message}</p>
      </div>
      <dl className="grid gap-2 font-mono text-[11px] text-ink-muted sm:grid-cols-2">
        <div><dt className="uppercase tracking-[0.1em]">Code</dt><dd className="mt-1 break-all text-ink">{code}</dd></div>
        <div><dt className="uppercase tracking-[0.1em]">Request ID</dt><dd className="mt-1 break-all text-ink">{requestId ?? "Unavailable"}</dd></div>
      </dl>
      <div><Button variant="secondary" size="sm" onClick={() => router.refresh()}>Try again</Button></div>
    </section>
  );
}
