import { ApiError } from "@/lib/api/client";
import type { ChartDatum } from "@/components/charts";
export type StatsOptions = { metric?: string; groupBy?: string; from?: string; to?: string; scope?: "mine" | "public" | "all" | "team"; teamId?: string; filters?: Record<string, string> };
export type Stats = { data: ChartDatum[]; meta: { metric: string; groupBy: string | null } };
export async function getStats(entity: string, options: StatsOptions = {}, signal?: AbortSignal): Promise<Stats> {
  const params = new URLSearchParams();
  for (const key of ["metric", "groupBy", "from", "to", "scope"] as const) { const value = options[key]; if (value) params.set(key, value); }
  if (options.scope === "team") {
    if (!options.teamId) throw new ApiError({ code: "VALIDATION_FAILED", status: 0, message: "Select a team to view team statistics." });
    params.set("teamId", options.teamId);
  }
  Object.entries(options.filters ?? {}).forEach(([key, value]) => { if (value !== "") params.set(`filter[${key}]`, value); });
  let response: Response;
  try { response = await fetch(`/api/v1/entities/${encodeURIComponent(entity)}/stats?${params}`, { signal, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } }); }
  catch (error) { if (signal?.aborted) throw error; throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "Could not reach the service. Check your connection and try again." }); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError({ code: body?.error?.code ?? `HTTP_${response.status}`, status: response.status, message: body?.error?.message ?? "Could not load statistics." });
  if (!body || !Array.isArray(body.data)) throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The server returned invalid statistics." });
  return body as Stats;
}
