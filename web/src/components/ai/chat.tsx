"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { getUsage, streamChat, type AiUsage, type ChatMessage } from "@/features/ai/client";
import { aiErrorView, isAllowanceView } from "@/features/ai/errors";

const MAX_LENGTH = 8000;

/** A failed reply, shown in the message list. `retryMessages` is set when the question can be asked again. */
type ChatError = { message: string; retryMessages?: ChatMessage[]; retryAt?: number };

export function Chat({ className = "" }: { className?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const toast = useToast();

  // Counts down a rate limit's wait, so Retry is enabled when it ends.
  const retryAt = error?.retryAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const waitSeconds = retryAt === undefined ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));

  useEffect(() => {
    let active = true;
    mounted.current = true;
    getUsage().then((result) => { if (active) setUsage(result); }).catch((reason) => { if (active) setUsageError(aiErrorView(reason).message); });
    return () => { active = false; mounted.current = false; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages, streaming, error]);

  async function run(history: ChatMessage[]) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setStreaming(true);
    setError(null);
    setMessages([...history, { role: "assistant", content: "" }]);
    follow.current = true;
    try {
      for await (const event of streamChat(history, { signal: request.signal })) {
        if (event.type === "delta") {
          setMessages((current) => {
            const updated = [...current];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") updated[updated.length - 1] = { ...last, content: last.content + event.text };
            return updated;
          });
        }
      }
    } catch (reason) {
      if (!request.signal.aborted) {
        const view = aiErrorView(reason);
        // The daily allowance is a toast: asking again won't help, and the conversation stays as it is.
        if (isAllowanceView(view)) toast.error(view);
        else setError({ message: view.message, retryMessages: history, retryAt: view.retryAfterSeconds === undefined ? undefined : Date.now() + view.retryAfterSeconds * 1000 });
      }
    } finally {
      controller.current = null;
      if (mounted.current) {
        setMessages((current) => current.at(-1)?.content ? current : current.slice(0, -1));
        setStreaming(false);
        getUsage().then((result) => {
          if (mounted.current) { setUsage(result); setUsageError(null); }
        }).catch((reason) => { if (mounted.current) setUsageError(aiErrorView(reason).message); });
      }
    }
  }

  function send() {
    const content = input.trim();
    if (!content || streaming) return;
    const history = [...messages, { role: "user" as const, content }];
    if (history.length > 40 || history.some((message) => Array.from(message.content).length > MAX_LENGTH) || history.reduce((total, message) => total + Array.from(message.content).length, 0) > 48000) {
      setError({ message: "This conversation has reached its length limit. Start a new conversation to continue." });
      return;
    }
    setInput("");
    void run(history);
  }

  const used = usage ? usage.inputTokens + usage.outputTokens : 0;
  return (
    <section className={`border-y border-rule ${className}`} aria-label="AI chat">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule py-4">
        <span className="font-mono text-[11px] tracking-[0.12em] uppercase">Conversation / 01</span>
        <Button type="button" variant="link" disabled={streaming || messages.length === 0} onClick={() => { setMessages([]); setError(null); }}>New conversation</Button>
      </div>
      <div ref={list} onScroll={(event) => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }} className="h-[min(50vh,32rem)] min-h-64 overflow-y-auto overscroll-contain" aria-label="Conversation messages">
        {messages.length === 0 && <p className="py-12 text-ink-muted">Your conversation starts here. What would you like to explore?</p>}
        {messages.map((message, index) => (
          <article key={index} className="grid gap-3 border-b border-rule py-6 sm:grid-cols-[8rem_1fr]">
            <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{message.role === "user" ? "You" : "Assistant"}</p>
            <p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed" aria-live={streaming && index === messages.length - 1 ? "polite" : undefined}>{message.content || (streaming ? "Thinking…" : "")}</p>
          </article>
        ))}
        {error && (
          <article className="grid gap-3 border-b border-rule py-6 sm:grid-cols-[8rem_1fr]">
            <p className="font-mono text-[11px] tracking-[0.12em] text-vermilion-deep uppercase">Error</p>
            <div className="min-w-0 space-y-3">
              <p role="alert" className="break-words leading-relaxed text-vermilion-deep">{error.message}</p>
              {waitSeconds > 0 && <p className="font-mono text-[11px] text-ink-muted">Try again in {waitSeconds} {waitSeconds === 1 ? "second" : "seconds"}</p>}
              {error.retryMessages && <Button type="button" variant="link" disabled={streaming || waitSeconds > 0} onClick={() => { if (error.retryMessages) void run(error.retryMessages); }}>Retry</Button>}
            </div>
          </article>
        )}
      </div>
      <div className="py-5">
        <label htmlFor="ai-message" className="font-mono text-[11px] tracking-[0.12em] uppercase">Your message</label>
        <textarea id="ai-message" value={input} maxLength={MAX_LENGTH} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder="Ask anything…" rows={3} className="mt-3 block w-full resize-y border border-rule bg-paper-raised p-4 text-ink placeholder:text-ink-muted" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          <p className="font-mono text-[11px] text-ink-muted">{input.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()} · Enter to send, Shift+Enter for a new line</p>
          {streaming ? <Button type="button" size="sm" onClick={() => controller.current?.abort()}>Stop</Button> : <Button type="button" size="sm" onClick={send} disabled={!input.trim()}>Send message</Button>}
        </div>
      </div>
      <div className="border-t border-rule py-4 font-mono text-[11px] text-ink-muted">
        {usage && <div className="space-y-2"><div className="flex flex-wrap justify-between gap-2"><span>Today's usage</span><span>{used.toLocaleString()} / {usage.dailyLimit.toLocaleString()} tokens</span></div><progress className="h-1 w-full accent-ink" value={Math.min(used, usage.dailyLimit)} max={Math.max(usage.dailyLimit, 1)} aria-label="Daily AI token usage" /></div>}
        {usageError ? <p className="mt-2">{usageError}</p> : !usage && <p>Loading usage…</p>}
      </div>
    </section>
  );
}
