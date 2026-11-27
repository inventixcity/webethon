// Captures the walkthrough screenshots from the running app (local or production) with headless Chrome.
// Usage: BASE=http://localhost:3000 node capture.mjs [onlyName]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3000";
const PASSWORD = "Invigil#Demo2026";
const OUT = "public/shots";
mkdirSync(OUT, { recursive: true });
const only = process.argv[2];

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${mkdtempSync(join(tmpdir(), "v-"))}`, "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((r) => chrome.stderr.on("data", (d) => { const m = String(d).match(/ws:\/\/\S+/); if (m) r(m[0]); }));
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, cookie } = {}) {
  const r = await fetch(BASE + "/api/v1" + path, { method, headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get("set-cookie");
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json, setCookie };
}
const cookies = {};
async function signIn(email) {
  if (cookies[email]) return cookies[email];
  const r = await api("/auth/signin", { method: "POST", body: { email, password: PASSWORD } });
  const m = r.setCookie && r.setCookie.match(/^([^=]+)=([^;]+)/);
  if (!m) throw new Error(`sign-in failed for ${email}: ${r.status}`);
  cookies[email] = { name: m[1], value: m[2], header: `${m[1]}=${m[2]}` };
  return cookies[email];
}

async function page(theme) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable");
  await s("Network.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1.5, mobile: false });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("theme","${theme}")}catch(e){}` });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  return { s, targetId };
}
const evalJs = async (s, expression) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const clickText = (s, re) => evalJs(s, `(()=>{const b=[...document.querySelectorAll('button,a,[role=tab]')].find(b=>${re}.test(b.textContent.trim())); if(!b) return 'missing'; b.scrollIntoView({block:'center'}); b.click(); return 'ok';})()`);

async function shoot(name, { email, path, theme = "light", before, settle = 2500, scrollTo, scrollText }) {
  if (only && only !== name) return;
  const { s, targetId } = await page(theme);
  if (email) {
    const c = await signIn(email);
    const host = new URL(BASE).hostname;
    await s("Network.setCookie", { name: c.name, value: c.value, domain: host, path: "/", secure: BASE.startsWith("https"), httpOnly: true });
  }
  await s("Page.navigate", { url: BASE + path });
  await wait(6000);
  // Hide dev overlays and the Next dev indicator so frames stay clean.
  await evalJs(s, `(()=>{const st=document.createElement('style'); st.textContent='nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none!important}'; document.head.appendChild(st); return 1})()`);
  if (scrollTo) await evalJs(s, `(()=>{const el=document.querySelector(${JSON.stringify(scrollTo)}); if(el){el.scrollIntoView({block:'start'}); window.scrollBy(0,-90);} return !!el})()`);
  if (scrollText) await evalJs(s, `(()=>{const el=[...document.querySelectorAll('h1,h2,h3,p,span,div')].find(e=>e.childElementCount<3&&e.textContent.trim().startsWith(${JSON.stringify(scrollText)})); if(!el) return false; const sc=el.closest('[class*=overflow-y-auto]'); const y=el.getBoundingClientRect().top; if(sc&&sc!==document.body) sc.scrollBy(0,y-110); else window.scrollBy(0,y-110); return true})()`);
  if (before) await before(s);
  await wait(settle);
  const r = await s("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log("shot", name);
  await send("Target.closeTarget", { targetId });
}

const EX = "examiner@invigil.app";
const AD = "admin@invigil.app";
const CA = "candidate@invigil.app";
const exams = (await api("/exams", { cookie: (await signIn(EX)).header })).json.data.items;
const byTitle = (re) => exams.find((e) => re.test(e.title));
const live = byTitle(/Web Security/i) ?? exams.find((e) => e.phase === "ongoing");
const done = byTitle(/Data Structures/i) ?? exams.find((e) => e.phase === "completed");
const draft = byTitle(/Operating Systems/i) ?? exams.find((e) => e.status === "draft");
console.log("exams:", live?.title, "|", done?.title, "|", draft?.title);

await shoot("landing", { path: "/" });
await shoot("bank", { email: EX, path: "/app/examiner/questions" });
await shoot("new-exam", { email: EX, path: "/app/examiner/exams/new" });
await shoot("paper", { email: EX, path: `/app/examiner/exams/${draft.id}/questions` });
await shoot("candidates", { email: EX, path: `/app/examiner/exams/${draft.id}/candidates` });
await shoot("review", { email: EX, path: `/app/examiner/exams/${draft.id}/review` });
await shoot("cand-home", { email: CA, path: "/app/candidate" });
await shoot("lobby", { email: CA, path: `/app/candidate/exams/${live.id}` });

// Start the candidate's live attempt, answer one question, then go offline and answer another.
let attemptId;
{
  const lobby = await api(`/me/exams/${live.id}`, { cookie: (await signIn(CA)).header });
  attemptId = lobby.json.data?.attemptId;
  if (!attemptId) {
    const st = await api(`/me/exams/${live.id}/attempt`, { method: "POST", cookie: (await signIn(CA)).header });
    attemptId = st.json.data?.attemptId;
  }
  console.log("attempt", attemptId);
}
const takeOver = async (s) => {
  for (const re of ["/continue on this device/i", "/continue without fullscreen/i"]) {
    await evalJs(s, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>${re}.test(b.textContent)); b?.click(); return 1})()`);
    await wait(1500);
  }
};
const pick = (s, n) => evalJs(s, `(()=>{const r=[...document.querySelectorAll('[role=radio],[role=checkbox],input[type=radio],input[type=checkbox]')]; r[${n}]?.click(); return r.length})()`);
await shoot("workspace", { email: CA, path: `/exam/${attemptId}`, before: async (s) => { await takeOver(s); await pick(s, 0); await wait(2500); } });
await shoot("offline", {
  email: CA,
  path: `/exam/${attemptId}`,
  before: async (s) => {
    await takeOver(s);
    await s("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await evalJs(s, `window.dispatchEvent(new Event('offline')); 1`);
    await wait(1500);
    await pick(s, 1);
    await wait(2500);
  },
});
await shoot("synced", {
  email: CA,
  path: `/exam/${attemptId}`,
  before: async (s) => { await takeOver(s); await pick(s, 2); await wait(3000); },
});

await shoot("monitor", { email: EX, path: `/app/examiner/exams/${live.id}/monitor`, settle: 6000, scrollText: "Control room" });
await shoot("monitor-dark", { email: EX, path: `/app/examiner/exams/${live.id}/monitor`, theme: "dark", settle: 6000, scrollText: "Control room" });
await shoot("grading", {
  email: EX,
  path: `/app/examiner/exams/${done.id}/grading`,
  scrollText: "Written answers",
  before: async (s) => { await clickText(s, /^all/i); await wait(2500); await clickText(s, /suggest/i); await wait(9000); await evalJs(s, `(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.childElementCount<2&&/suggested mark|ai suggestion/i.test(e.textContent)); if(el) el.scrollIntoView({block:'center'}); return !!el})()`); },
});
await shoot("analytics", { email: EX, path: `/app/examiner/exams/${done.id}/analytics`, settle: 4000, scrollText: "02 / Distribution" });
await shoot("results", { email: EX, path: `/app/examiner/exams/${done.id}/results`, scrollText: "Published" });
{
  const { execSync } = await import("node:child_process");
  const code = execSync(`docker exec invigil-postgres-1 psql -U postgres -d invigil -tAc "select rc.verify_code from result_certificates rc join attempts a on a.id=rc.attempt_id where a.exam_id='${done.id}' and rc.revoked_at is null order by a.total_score desc limit 1"`, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString().trim();
  if (code) await shoot("verify", { path: `/verify/${code}`, settle: 4000 });
  else console.log("no verify code found");
}
await shoot("admin", { email: AD, path: "/admin", settle: 4000 });
await shoot("audit", { email: AD, path: "/admin/audit" });
await shoot("requests", { email: AD, path: "/admin/requests" });
await shoot("settings-dark", { email: AD, path: "/app/settings", theme: "dark" });

chrome.kill();
process.exit(0);
