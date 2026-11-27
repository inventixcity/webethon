import { api, ApiError } from "@/lib/api/client";

export type Source = { entity: string; id: string; label: string };
export type PendingAction = { actionId: string; kind: string; entity: string; recordId?: string; data: unknown; version?: number; expiresAt: string };
export type AskEvent = { type: "delta"; text: string } | { type: "sources"; sources: Source[] } | { type: "pending"; pendingActions: PendingAction[] } | { type: "done"; usage: { input: number; output: number } };

export const confirmAction = (actionId: string) => api<{ record: unknown }>("/assist/confirm", { body: { actionId } });
export const cancelAction = (actionId: string) => api<void>("/assist/cancel", { body: { actionId } });

export async function* ask(question: string, entity: string | undefined, signal: AbortSignal): AsyncGenerator<AskEvent> {
  let response: Response;
  try {
    response = await fetch("/api/v1/assist/ask", { method: "POST", headers: { accept: "text/event-stream", "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ question, ...(entity ? { entity } : {}) }), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "Could not reach the service. Please try again." });
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError({ code: body?.error?.code ?? `HTTP_${response.status}`, status: response.status, message: body?.error?.message ?? "Could not complete the request." });
  }
  if (!response.body) throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was empty." });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", eventName = "";
  let data: string[] = [];
  function dispatch(): AskEvent | undefined {
    if (!data.length) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(data.join("\n")) as Record<string, unknown>; } catch { throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was unreadable." }); }
    if (!value || typeof value !== "object") throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was unreadable." });
    if (eventName === "error") throw new ApiError({ code: typeof value.code === "string" ? value.code : "UNAVAILABLE", status: response.status, message: typeof value.message === "string" ? value.message : "The request failed." });
    if (eventName === "delta" && typeof value.text === "string") return { type: "delta", text: value.text };
    if (eventName === "sources" && Array.isArray(value.sources)) return { type: "sources", sources: value.sources as Source[] };
    if (eventName === "pending" && Array.isArray(value.pendingActions)) return { type: "pending", pendingActions: value.pendingActions as PendingAction[] };
    if (eventName === "done") return { type: "done", usage: value.usage as { input: number; output: number } };
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.search(/[\r\n]/)) !== -1) {
        if (buffer[newline] === "\r" && newline === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1));
        if (!line) {
          const event = dispatch(); eventName = ""; data = [];
          if (event) { yield event; if (event.type === "done") return; }
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") eventName = value;
          if (field === "data") data.push(value);
        }
      }
      if (chunk.done) break;
    }
    throw new ApiError({ code: "UNAVAILABLE", status: response.status, message: "The response ended early. Please try again." });
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
