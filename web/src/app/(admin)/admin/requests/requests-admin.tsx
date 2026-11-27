"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/feedback/toaster";
import { ApiError, api } from "@/lib/api/client";

type RequestStatus = "new" | "contacted" | "onboarded" | "declined";

type InstituteRequest = {
  id: string;
  institute: string;
  contactName: string;
  email: string;
  phone: string | null;
  role: string | null;
  expectedCandidates: number | null;
  message: string;
  status: RequestStatus;
  createdAt: string;
};

type PageData = { items: InstituteRequest[]; limit: number; offset: number };

const statuses: RequestStatus[] = ["new", "contacted", "onboarded", "declined"];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function RequestsAdmin() {
  const [items, setItems] = useState<InstituteRequest[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const query = status ? `&status=${encodeURIComponent(status)}` : "";
      const data = await api<PageData>(`/institute-requests?limit=100${query}`);
      setItems(data.items);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load institute requests."));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(id: string, next: RequestStatus) {
    setBusy(id);
    try {
      await api(`/institute-requests/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { status: next },
      });
      setItems((current) => current.map((item) => item.id === id ? { ...item, status: next } : item));
      toast.success("Request updated.");
    } catch (error) {
      toast.error(errorMessage(error, "Could not update request."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="requests-heading" className="grid min-w-0 gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Institute enquiries</p>
          <h1 id="requests-heading" className="mt-2 break-words text-3xl font-medium">Requests</h1>
        </div>
        <label className="grid min-w-[min(100%,12rem)] gap-1 font-mono text-[11px] tracking-[0.1em] uppercase">
          Filter status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="min-h-11 border border-rule bg-paper px-3 font-sans text-sm normal-case"
          >
            <option value="">All statuses</option>
            {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      {loading ? <p role="status" className="py-12 text-sm text-ink-muted">Loading requests…</p> : null}
      {!loading && loadError ? (
        <div role="alert" className="grid justify-items-start gap-3 border border-vermilion-deep p-5">
          <p className="break-words text-sm text-vermilion-deep">{loadError}</p>
          <Button type="button" variant="secondary" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      {!loading && !loadError && items.length === 0 ? (
        <p className="border border-rule p-6 text-sm text-ink-muted">No institute requests found.</p>
      ) : null}
      {!loading && !loadError && items.length > 0 ? (
        <ul className="grid min-w-0 gap-3">
          {items.map((request) => (
            <li key={request.id}>
              <article className="grid min-w-0 gap-4 border border-rule p-4 md:grid-cols-[minmax(0,1fr)_auto] md:p-5">
                <div className="grid min-w-0 gap-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-3">
                    <h2 className="min-w-0 break-words text-xl font-medium">{request.institute}</h2>
                    <span className="border border-rule bg-paper-sunk px-2 py-1 font-mono text-[11px] tracking-[0.1em] uppercase">{request.status}</span>
                  </div>
                  <p className="min-w-0 break-words text-sm text-ink-soft">
                    {request.contactName}
                    {" · "}
                    <a className="inline-flex min-h-11 max-w-full items-center break-all underline underline-offset-2" href={`mailto:${request.email}`}>
                      {request.email}
                    </a>
                    {request.phone ? ` · ${request.phone}` : ""}
                  </p>
                  <p className="break-words text-sm leading-relaxed">{request.message}</p>
                  <p className="break-words font-mono text-[11px] text-ink-muted">
                    {[request.role || "Role not given", request.expectedCandidates == null ? "Candidates unspecified" : `${request.expectedCandidates} candidates`, new Date(request.createdAt).toLocaleString()].join(" · ")}
                  </p>
                </div>
                <label className="grid content-start gap-1 font-mono text-[11px] tracking-[0.1em] uppercase md:min-w-40">
                  Update status
                  <select
                    aria-label={`Status for ${request.institute}`}
                    disabled={busy === request.id}
                    value={request.status}
                    onChange={(event) => void change(request.id, event.target.value as RequestStatus)}
                    className="min-h-11 w-full border border-rule bg-paper px-3 font-sans text-sm normal-case disabled:opacity-60"
                  >
                    {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
