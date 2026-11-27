import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";

// Exercise real IndexedDB transaction scheduling, including independent browsing contexts.
// A mock that completes transactions synchronously cannot reproduce the original lost-answer bug.
const chrome = process.env.CHROME_PATH ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const browserIt = chrome ? it : it.skip;
let processHandle: ChildProcess;
let server: Server;
let directory: string;
let socket: WebSocket;
let nextId = 0;
const requests = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
const call = (method: string, params: unknown = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const id = ++nextId; requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});

beforeAll(async () => {
  if (!chrome) return;
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Invigil journal verification</title>"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  directory = mkdtempSync(join(tmpdir(), "invigil-journal-"));
  processHandle = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${directory}`, `http://127.0.0.1:${address.port}`], { stdio: "ignore", windowsHide: true });
  const portFile = join(directory, "DevToolsActivePort");
  for (let attempt = 0; !existsSync(portFile) && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  let pages: Array<{ type: string; url: string; webSocketDebuggerUrl: string }> = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as typeof pages;
    if (pages.some((page) => page.url.startsWith("http://127.0.0.1:"))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const page = pages.find((value) => value.type === "page" && value.url.startsWith("http://127.0.0.1:"));
  if (!page) throw new Error("Browser page did not start");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Browser connection failed")), { once: true }); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result: Record<string, unknown> };
    if (message.id === undefined) return;
    const request = requests.get(message.id); requests.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result);
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call("Runtime.evaluate", { expression: "({url:location.href,secure:isSecureContext,ready:document.readyState})", returnByValue: true });
    const value = (response.result as { value?: { secure: boolean; ready: string } })?.value;
    if (value?.secure && value.ready === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (attempt === 99) throw new Error(`Secure browser page did not load: ${JSON.stringify(response)}`);
  }
}, 20_000);

afterAll(async () => {
  socket?.close(); processHandle?.kill();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("invigil-journal-")) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Chrome may still be releasing its profile. */ }
  }
});

const source = readFileSync(new URL("./journal.ts", import.meta.url), "utf8").replace(/^import type[^;]+;/gm, "").replace(/^export /gm, "");
const javascript = stripTypeScriptTypes(source);

browserIt("keeps all answers and one valid chain across concurrent tabs, metadata updates and acknowledgements", async () => {
  const expression = `(async () => {
    ${javascript}
    const id = crypto.randomUUID();
    const genesis = toBase64Url(Uint8Array.from({length:32}, (_,i)=>i));
    const lease = {attemptId:id, issuedAt:Date.now(), deadlineAt:Date.now()+600000, mac:'test'};
    await initializeJournal(id,genesis,null,0);
    await setLease(id,lease);
    const frame = document.createElement('iframe'); frame.src = location.href;
    await new Promise(resolve => {frame.onload=resolve; document.body.append(frame)});
    frame.contentWindow.eval(${JSON.stringify(javascript)});
    const jobs = Array.from({length:48}, (_,index) => {
      const append = index % 2 ? frame.contentWindow.appendEntry : appendEntry;
      return append(id,'00000000-0000-0000-0000-'+String(index).padStart(12,'0'),{text:'Answer '+index},false,lease,1);
    });
    const updates = Array.from({length:16}, () => setLease(id,lease));
    await Promise.all([...jobs,...updates]);
    const entries = await listEntries(id,Number.MAX_SAFE_INTEGER);
    let prev = fromBase64Url(genesis);
    let valid = entries.length === 48;
    for (let i=0;i<entries.length;i++) {
      const entry = entries[i];
      valid = valid && entry.seq === i+1 && entry.hash === await chainNext(prev,entry.seq,entry.itemId,entry.response,entry.writtenAt);
      prev = fromBase64Url(entry.hash);
    }
    const last = entries.at(-1);
    await acknowledgeEntries(id,[1,2],entries[1].hash,2);
    const meta = await getMeta(id);
    const counters = await Promise.all(Array.from({length:20},()=>nextClientSeq(id)));
    const reload = await frame.contentWindow.nextClientSeq(id);
    const remaining = (await listEntries(id,100)).length;
    await acknowledgeEntries(id,entries.map(entry=>entry.seq),last.hash,last.seq);
    await cacheAnswer(id,{itemId:entries[0].itemId,response:{text:'stale overwrite'},flagged:true,clientSeq:1,savedAt:new Date().toISOString()});
    const cached = await frame.contentWindow.cachedAnswers(id);
    const cacheValid = cached.length === 48 && cached.every(answer => {
      const entry=entries.find(entry=>entry.itemId===answer.itemId);
      return entry && answer.response.text===entry.response.text && answer.clientSeq===JOURNAL_SEQ_BASE+entry.seq;
    });
    return { valid, count:entries.length, distinct:new Set(entries.map(e=>e.itemId)).size, head:meta.head, expectedHead:last.hash, seq:meta.seq, lease:meta.lease, counters, reload, remaining, cacheValid, finalPending:(await listEntries(id,100)).length };
  })()`;
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  const result = (response.result as { value: { valid: boolean; count: number; distinct: number; head: string; expectedHead: string; seq: number; lease: unknown; counters: number[]; reload: number; remaining: number; cacheValid: boolean; finalPending: number } }).value;
  expect(result.valid).toBe(true);
  expect(result.count).toBe(48); expect(result.distinct).toBe(48);
  expect(result.head).toBe(result.expectedHead); expect(result.seq).toBe(48); expect(result.lease).toBeTruthy();
  expect(result.counters).toEqual(Array.from({ length: 20 }, (_, i) => 1_000_000_049 + i));
  expect(result.reload).toBe(1_000_000_069); expect(result.remaining).toBe(46);
  expect(result.finalPending).toBe(0); expect(result.cacheValid).toBe(true);
}, 20_000);
