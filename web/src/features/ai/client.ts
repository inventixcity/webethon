import { api, ApiError } from "@/lib/api/client";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type AiUsage = { day: string; requests: number; inputTokens: number; outputTokens: number; dailyLimit: number };
export type ChatEvent = { type: "delta"; text: string } | { type: "done"; usage: { input: number; output: number }; finishReason: string };

export function getUsage(): Promise<AiUsage> {
  return api<AiUsage>("/ai/usage");
}

export async function* streamChat(messages: ChatMessage[], { signal }: { signal?: AbortSignal } = {}): AsyncGenerator<ChatEvent> {
  let response: Response;
  try {
    response = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: "We can't reach the service right now. Please try again." });
  }
  if (!response.ok) {
    const envelope = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError({ code: envelope?.error?.code ?? `HTTP_${response.status}`, status: response.status, message: envelope?.error?.message ?? "Something went wrong. Please try again.", details: envelope?.error?.details });
  }
  if (!response.body) throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was empty. Please try again." });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let data: string[] = [];
  function dispatch(): ChatEvent | undefined {
    if (!data.length) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was unreadable. Please try again." });
    }
    if (typeof payload !== "object" || payload === null) throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The response was unreadable. Please try again." });
    const record = payload as Record<string, unknown>;
    if (eventName === "error") throw new ApiError({ code: typeof record.code === "string" ? record.code : "UNAVAILABLE", status: response.status, message: typeof record.message === "string" ? record.message : "Something went wrong. Please try again." });
    if (eventName === "delta" && typeof record.text === "string") return { type: "delta", text: record.text };
    if (eventName === "done") return { type: "done", usage: record.usage as { input: number; output: number }, finishReason: typeof record.finishReason === "string" ? record.finishReason : "" };
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.search(/[\r\n]/)) !== -1) {
        if (buffer[newline] === "\r" && newline === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, newline);
        const separatorLength = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(newline + separatorLength);
        if (line === "") {
          const event = dispatch();
          eventName = "";
          data = [];
          if (event) {
            yield event;
            if (event.type === "done") return;
          }
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") eventName = value;
          if (field === "data") data.push(value);
        }
      }
      if (chunk.done) break;
    }
    throw new ApiError({ code: "UNAVAILABLE", status: response.status, message: "The response ended early. Please try again." });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
