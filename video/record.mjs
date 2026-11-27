// Records real screen video of the live site, one clip per scene. Usage: node record.mjs [scene...]
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE = process.env.BASE ?? "https://invigil-ivory.vercel.app";
const PASSWORD = "Invigil#Demo2026";
const OUT = resolve("public/clips");
mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
const FFMPEG = resolve("node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe");

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${mkdtempSync(join(tmpdir(), "r-"))}`, "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((r) => chrome.stderr.on("data", (d) => { const m = String(d).match(/ws:\/\/\S+/); if (m) r(m[0]); }));
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pend = new Map();
const listeners = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method) for (const l of listeners) l(m);
});
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A visible cursor with a click ripple, injected into every page (screencasts don't show the real pointer).
const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div'); c.id='__cur';
    c.style.cssText='position:fixed;left:0;top:0;width:26px;height:30px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 60ms linear';
    c.innerHTML='<svg width="26" height="30" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="#12110E" stroke="#F3EEE3" stroke-width="1.3"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.transform = 'translate('+(e.clientX-2)+'px,'+(e.clientY-2)+'px)'; }, true);
    addEventListener('mousedown', e => {
      const r=document.createElement('div');
      r.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;left:'+(e.clientX-22)+'px;top:'+(e.clientY-22)+'px;width:44px;height:44px;border:3px solid #2B4FD8;transition:transform 380ms ease-out,opacity 380ms ease-out;transform:scale(.3);opacity:1';
      document.documentElement.appendChild(r); requestAnimationFrame(()=>{r.style.transform='scale(1.5)';r.style.opacity='0'}); setTimeout(()=>r.remove(),420);
    }, true);
    const st=document.createElement('style'); st.textContent='nextjs-portal,[data-nextjs-toast]{display:none!important}'; document.documentElement.appendChild(st);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})()`;

async function api(path, { method = "GET", body, cookie } = {}) {
  const r = await fetch(BASE + "/api/v1" + path, { method, headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})), setCookie: r.headers.get("set-cookie") };
}
const cookies = {};
async function signIn(email) {
  if (cookies[email]) return cookies[email];
  const r = await api("/auth/signin", { method: "POST", body: { email, password: PASSWORD } });
  const m = r.setCookie && r.setCookie.match(/^([^=]+)=([^;]+)/);
  if (!m) throw new Error(`sign-in failed for ${email}: ${r.status}`);
  return (cookies[email] = { name: m[1], value: m[2], header: `${m[1]}=${m[2]}` });
}

async function newPage({ width = 1920, height = 1080, mobile = false, scale = 1, theme = "light", email }) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable");
  await s("Network.enable");
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
  if (mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: false });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("theme","${theme}")}catch(e){}` });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR });
  if (email) {
    const c = await signIn(email);
    await s("Network.setCookie", { name: c.name, value: c.value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true });
  }
  const p = { s, sessionId, targetId, width, height, x: width * 0.6, y: height * 0.7 };
  p.eval = async (expression) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  p.go = async (path, settle = 2500) => { await s("Page.navigate", { url: BASE + path }); await wait(settle); await p.eval(CURSOR); await p.mouse(p.x, p.y, 1); };
  p.mouse = async (x, y, steps = 18) => {
    const sx = p.x, sy = p.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + (x - sx) * e, y: sy + (y - sy) * e });
      await wait(16);
    }
    p.x = x; p.y = y;
  };
  p.box = async (finder) => p.eval(`(()=>{const el=(${finder})(); if(!el) return null; el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  p.clickAt = async (x, y) => { await p.mouse(x, y); await wait(120); await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await wait(70); await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); await wait(350); };
  p.click = async (finder) => { const b = await p.box(finder); if (!b) { console.log("  (missing target)"); return false; } await wait(250); await p.clickAt(b.x, b.y); return true; };
  p.text = (re, sel = "button,a,[role=tab],[role=radio],[role=checkbox],label") => `()=>[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>${re}.test(e.textContent.trim()))`;
  p.type = async (text, delay = 45) => { for (const ch of text) { await s("Input.insertText", { text: ch }); await wait(delay); } };
  // Smooth scroll of the page, or of the main scroll container if the page itself doesn't scroll.
  p.scroll = async (dy, ms = 2500) => {
    await p.eval(`(async()=>{const cands=[document.scrollingElement,...document.querySelectorAll('main,[class*=overflow-y-auto]')]; const el=cands.find(e=>e&&e.scrollHeight>e.clientHeight+20)||document.scrollingElement; const start=el.scrollTop, t0=performance.now(); await new Promise(res=>{function f(now){const t=Math.min(1,(now-t0)/${ms}); const e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2; el.scrollTop=start+${dy}*e; t<1?requestAnimationFrame(f):res()} requestAnimationFrame(f)}); return 1})()`);
  };
  return p;
}

async function record(name, opts, run) {
  if (want.length && !want.includes(name)) return;
  console.log("rec", name);
  const p = await newPage(opts);
  if (opts.start) await p.go(opts.start, opts.settle ?? 3500);
  const dir = join(tmpdir(), `clip-${name}-${Date.now()}`);
  mkdirSync(dir);
  const frames = [];
  const onFrame = (m) => {
    if (m.method !== "Page.screencastFrame" || m.sessionId !== p.sessionId) return;
    const f = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(f, Buffer.from(m.params.data, "base64"));
    frames.push({ f, t: m.params.metadata.timestamp });
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, p.sessionId);
  };
  listeners.push(onFrame);
  await p.s("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: opts.width ?? 1920, maxHeight: opts.height ?? 1080, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  await wait(400);
  try { await run(p); } catch (e) { console.log("  error:", e.message); }
  await wait(600);
  const t1 = Date.now() / 1000;
  await p.s("Page.stopScreencast");
  listeners.splice(listeners.indexOf(onFrame), 1);
  if (!frames.length) { console.log("  no frames"); return; }
  // Constant 30 fps: each frame lasts until the next one arrives.
  let list = "";
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : t1;
    const start = i === 0 ? Math.min(frames[0].t, t0) : frames[i].t;
    list += `file '${frames[i].f.replace(/\\/g, "/")}'\nduration ${Math.max(0.001, next - start).toFixed(4)}\n`;
  }
  list += `file '${frames[frames.length - 1].f.replace(/\\/g, "/")}'\n`;
  writeFileSync(join(dir, "list.txt"), list);
  const out = join(OUT, `${name}.mp4`);
  try {
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", out]);
  } catch (e) {
    console.log("  encode failed:", String(e.stderr ?? e).slice(0, 300));
  }
  console.log(`  ${name}.mp4 ${(t1 - t0).toFixed(1)}s, ${frames.length} frames`);
  rmSync(dir, { recursive: true, force: true });
  await send("Target.closeTarget", { targetId: p.targetId });
}

const EX = "examiner@invigil.app", CA = "candidate@invigil.app", AD = "admin@invigil.app";
const exams = (await api("/exams", { cookie: (await signIn(EX)).header })).json.data.items;
const find = (re) => exams.find((e) => re.test(e.title));
const live = find(/^CS-305/), done = find(/^CS-218/), draft = find(/^CS-330/);
console.log("exams:", live?.title, "|", done?.title, "|", draft?.title);

await record("landing", { start: "/" }, async (p) => {
  await wait(1500);
  for (let i = 0; i < 7; i++) { await p.scroll(900, 1500); await wait(500); }
  await p.mouse(1300, 300);
});
await record("signin", { start: "/login" }, async (p) => {
  await p.click(`()=>document.querySelector('input[name=email]')`);
  await p.type(EX, 35);
  await p.click(`()=>document.querySelector('input[name=password]')`);
  await p.type(PASSWORD, 45);
  await p.click(p.text("/^sign in$/i", "button"));
  await wait(4500);
});
await record("bank", { email: EX, start: "/app/examiner/questions" }, async (p) => {
  await wait(800);
  await p.click(`()=>[...document.querySelectorAll('li,article,[role=button]')].find(e=>/database|sql/i.test(e.textContent)&&e.getBoundingClientRect().height<200)`);
  await wait(1500);
  await p.scroll(500, 1800);
  await wait(800);
  await p.click(`()=>[...document.querySelectorAll('li,article,[role=button]')].filter(e=>e.getBoundingClientRect().height<200&&e.getBoundingClientRect().height>40)[3]`);
  await wait(1800);
});
await record("exam", { email: EX, start: "/app/examiner/exams/new" }, async (p) => {
  await p.scroll(420, 1200);
  await p.click(`()=>document.querySelector('input[name=title],#title,input[type=text]')`);
  await p.type("CS-499 Capstone: Viva Voce", 40);
  await p.click(`()=>document.querySelector('textarea')`);
  await p.type("Answer every question. Your work saves automatically, even offline.", 22);
  await wait(500);
  for (let i = 0; i < 3; i++) { await p.scroll(650, 1400); await wait(500); }
});
await record("paper", { email: EX, start: `/app/examiner/exams/${draft.id}/questions` }, async (p) => {
  await wait(600);
  for (let i = 0; i < 3; i++) { await p.scroll(600, 1500); await wait(700); }
});
await record("publish", { email: EX, start: `/app/examiner/exams/${draft.id}/candidates` }, async (p) => {
  await p.scroll(500, 1500); await wait(700);
  await p.click(p.text("/^review$/i", "a"));
  await wait(3000);
  await p.scroll(550, 1600); await wait(900);
  await p.scroll(500, 1400); await wait(800);
});
await record("candidate", { email: CA, start: "/app/candidate" }, async (p) => {
  await wait(1200);
  await p.scroll(500, 1500); await wait(600);
  await p.click(p.text("/resume exam|open lobby|start|enter/i", "a,button"));
  await wait(3500);
  await p.scroll(700, 1800); await wait(500);
  await p.click(`()=>document.querySelector('[role=checkbox],button[role=checkbox],input[type=checkbox]')`);
  await wait(600);
  await p.click(p.text("/start exam|resume exam/i", "button"));
  await wait(5000);
});
let attemptId;
{
  const l = await api(`/me/exams/${live.id}`, { cookie: (await signIn(CA)).header });
  attemptId = l.json.data?.attemptId;
  console.log("attempt", attemptId);
}
const enter = async (p) => {
  for (const re of ["/continue on this device/i", "/continue without fullscreen/i"]) { await p.click(p.text(re, "button")); await wait(1200); }
};
const option = (n) => `()=>[...document.querySelectorAll('#ws-questions label, #ws-questions [role=radio], #ws-questions [role=checkbox]')][${n}]`;
await record("workspace", { email: CA, start: `/exam/${attemptId}`, settle: 4500 }, async (p) => {
  await enter(p);
  await p.click(option(0)); await wait(900);
  await p.click(option(2)); await wait(900);
  await p.scroll(520, 1300); await wait(500);
  await p.click(option(5)); await wait(900);
  await p.click(p.text("/flag for review/i", "button")); await wait(900);
  await p.click(p.text("/^scratchpad$/i", "button")); await wait(1500);
  await p.type("a = 2, b = 3", 60); await wait(800);
  await p.click(p.text("/^scratchpad$/i", "button")); await wait(900);
});
await record("offline", { email: CA, start: `/exam/${attemptId}`, settle: 4500 }, async (p) => {
  await enter(p);
  await p.s("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.eval(`window.dispatchEvent(new Event('offline')); 1`);
  await wait(1800);
  await p.scroll(1000, 1400); await wait(400);
  await p.click(option(7)); await wait(1200);
  await p.click(option(9)); await wait(2200);
  await p.s("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.eval(`window.dispatchEvent(new Event('online')); 1`);
  await wait(5000);
});
await record("monitor", { email: EX, start: `/app/examiner/exams/${live.id}/monitor`, settle: 5000 }, async (p) => {
  await p.scroll(560, 1600); await wait(2500);
  await p.scroll(650, 1600); await wait(1500);
  await p.click(`()=>document.querySelector('tbody tr, [role=row]:not(:first-child), ul li button')`); await wait(2500);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await wait(600);
});
await record("grading", { email: EX, start: `/app/examiner/exams/${done.id}/grading`, settle: 4500 }, async (p) => {
  await p.click(p.text("/^all/i", "button")); await wait(1500);
  await p.scroll(380, 1300); await wait(600);
  await p.click(p.text("/suggest a mark/i", "button")); await wait(8000);
  await p.scroll(350, 1300); await wait(1500);
});
await record("results", { email: EX, start: `/app/examiner/exams/${done.id}/analytics`, settle: 5000 }, async (p) => {
  for (let i = 0; i < 4; i++) { await p.scroll(650, 1400); await wait(700); }
  await p.click(p.text("/^results$/i", "a")); await wait(3500);
  await p.scroll(520, 1500); await wait(1200);
});
let code;
{
  const r = await api(`/exams/${done.id}/results`, { cookie: (await signIn(EX)).header });
  const flat = JSON.stringify(r.json);
  code = process.env.VERIFY_CODE || (flat.match(/"verifyCode":"([A-Z0-9-]{12,14})"/) || [])[1];
  console.log("verify code", code ? "found" : "missing");
}
await record("verify", { start: "/verify", settle: 3500 }, async (p) => {
  if (!code) return;
  await p.click(`()=>document.querySelector('input')`);
  await p.type(code.replace(/-/g, ""), 90);
  await wait(500);
  await p.click(p.text("/verify code/i", "button"));
  await wait(5000);
});
await record("admin", { email: AD, start: "/admin", settle: 5000 }, async (p) => {
  await p.scroll(600, 1500); await wait(1500);
  await p.click(p.text("/^audit$/i", "a")); await wait(3500);
  await p.scroll(400, 1300); await wait(800);
  await p.click(p.text("/^requests$/i", "a")); await wait(3500);
});
await record("mobile-portrait", { width: 390, height: 844, mobile: true, scale: 2, start: "/" }, async (p) => {
  for (let i = 0; i < 4; i++) { await p.scroll(700, 900); await wait(250); }
});
await record("mobile-landscape", { width: 844, height: 390, mobile: true, scale: 2, email: EX, start: "/app/examiner" }, async (p) => {
  for (let i = 0; i < 4; i++) { await p.scroll(330, 900); await wait(250); }
});

chrome.kill();
process.exit(0);
