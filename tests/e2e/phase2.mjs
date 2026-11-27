// Invigil phase-2 end-to-end checks against a running API: fair papers (5.2), disputes (5.4),
// AI grading assistant, live room stream and bulk outage credit. Plain Node 24, no dependencies.
//
//   API_URL=http://localhost:8080 node tests/e2e/phase2.mjs
//
// Needs the demo seed. Creates its own exam and candidate, so demo data is not modified.

import { randomUUID } from "node:crypto";

const base = (process.env.API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const api = `${base}/api/v1`;
const password = process.env.DEMO_PASSWORD ?? "Invigil#Demo2026";
const examinerEmail = process.env.EXAMINER_EMAIL ?? "examiner@invigil.app";
const device = `p2_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const candidateHeaders = { "X-Attempt-Device": device };
const iso = (ms) => new Date(ms).toISOString();
const tag = randomUUID().slice(0, 8);

const results = [];
let aborted = false;
class StepError extends Error {}
const check = (condition, message) => { if (!condition) throw new StepError(message); };

async function step(name, fn) {
  if (aborted) { results.push({ name, status: "skip" }); console.log(`  SKIP  ${name}`); return undefined; }
  try { const value = await fn(); results.push({ name, status: "pass" }); console.log(`  PASS  ${name}`); return value; }
  catch (error) { results.push({ name, status: "fail" }); console.log(`  FAIL  ${name}\n        ${error.message}`); return undefined; }
}
async function must(name, fn) {
  const before = results.length; const value = await step(name, fn);
  if (results[before]?.status === "fail") aborted = true;
  return value;
}

async function request(path, { method = "GET", body, cookie, headers = {}, expect } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { text }; }
  const acceptable = expect === undefined ? null : [expect].flat();
  const ok = acceptable ? acceptable.includes(response.status) : response.ok;
  if (!ok) throw new StepError(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
  return { status: response.status, data: json && typeof json === "object" && "data" in json ? json.data : json, json, cookies: response.headers.getSetCookie() };
}
const cookieHeader = (cookies) => cookies.map((value) => value.split(";", 1)[0]).join("; ");
async function signIn(email, pass = password) {
  const result = await request("/auth/signin", { method: "POST", body: { email, password: pass } });
  const cookie = cookieHeader(result.cookies); check(cookie, `no session cookie for ${email}`); return cookie;
}

console.log(`Invigil phase-2 e2e against ${api}\n`);
const examiner = await must("examiner signs in", () => signIn(examinerEmail));

// ------------------------------------------------------------------ 5.2 fair papers
const topic = `P2 Fair ${tag}`;
const questions = await must("examiner creates 6 questions across difficulties", async () => {
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const { data } = await request("/questions", { method: "POST", cookie: examiner, body: {
      topic, difficulty: (i % 5) + 1, kind: "single", stem: `Fair paper question ${i + 1}: pick A.`,
      options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correct: ["a"], marks: 2, negativeMarks: 0,
      multiRule: "all_or_nothing", rubric: "", maxWords: null, explanation: "",
    } });
    ids.push(data.id);
  }
  return ids;
});

let exam = await must("examiner creates a draft exam (total 6 marks)", async () => {
  const now = Date.now();
  const { data } = await request("/exams", { method: "POST", cookie: examiner, body: {
    title: `Fair paper e2e ${tag}`, instructions: "Phase 2 e2e.", startsAt: iso(now - 60_000), endsAt: iso(now + 2 * 3600_000),
    durationMinutes: 30, totalMarks: 6, passMarks: 2,
    settings: { shuffleQuestions: true, shuffleOptions: true, allowOfflineJournal: true, lateJoinMinutes: null, showBreakdown: true,
      integrity: { watermark: true, canary: false, fullscreen: false } },
  } });
  return data;
});

await must("examiner assigns the 6-question pool", () =>
  request(`/exams/${exam.id}/questions`, { method: "PUT", cookie: examiner, body: { items: questions.map((questionId) => ({ questionId })) } }));

await must("examiner saves a blueprint: 3 questions x 2 marks from the pool", () =>
  request(`/exams/${exam.id}/blueprint`, { method: "PUT", cookie: examiner, body: {
    enabled: true, rows: [{ topic, minDifficulty: 1, maxDifficulty: 5, count: 3, marksEach: 2 }], tolerance: 0.1 } }));

await step("blueprint preview is feasible with a fairness score", async () => {
  const { data } = await request(`/exams/${exam.id}/blueprint/preview`, { cookie: examiner });
  check(data.feasible === true, `not feasible: ${JSON.stringify(data.problems)}`);
  check(data.paperSize === 3 && data.poolSize === 6, `sizes ${data.paperSize}/${data.poolSize}`);
  check(Array.isArray(data.simulated) && data.simulated.length === 50, "50 simulated papers expected");
  check(data.fairnessScore >= 0 && data.fairnessScore <= 100, `score ${data.fairnessScore}`);
});

const candidateEmail = `p2-${tag}@example.test`;
const invite = await must("examiner enrolls a new candidate and gets an invite link", async () => {
  const { data } = await request(`/exams/${exam.id}/enrollments`, { method: "POST", cookie: examiner, body: {
    candidates: [{ email: candidateEmail, displayName: "Phase Two" }], invite: true, dryRun: false } });
  const url = data.inviteLinks?.[0]?.url;
  check(url, `no invite link: ${JSON.stringify(data).slice(0, 200)}`);
  return url.split("/invite/")[1];
});
const candidate = await must("candidate accepts the invite", async () => {
  const result = await request("/invites/accept", { method: "POST", body: { token: invite, password: "Phase2-e2e-Pass!", displayName: "Phase Two" } });
  return cookieHeader(result.cookies) || signIn(candidateEmail, "Phase2-e2e-Pass!");
});

await must("examiner publishes the exam", async () => {
  const { data } = await request(`/exams/${exam.id}`, { cookie: examiner });
  return request(`/exams/${exam.id}/publish`, { method: "POST", cookie: examiner, headers: { "If-Match": String(data.version) }, body: {} });
});

const attempt = await must("candidate starts: a 3-question paper is drawn", async () => {
  const { data } = await request(`/me/exams/${exam.id}/attempt`, { method: "POST", cookie: candidate, headers: candidateHeaders, body: {} });
  const { data: payload } = await request(`/attempts/${data.attemptId}`, { cookie: candidate, headers: candidateHeaders });
  check(payload.items.length === 3, `expected 3 items, got ${payload.items.length}`);
  check(payload.items.every((item) => item.marks === 2), `every drawn item carries the blueprint marks: ${payload.items.map((i) => i.marks)}`);
  return payload;
});

await step("fairness report counts the paper", async () => {
  const { data } = await request(`/exams/${exam.id}/fairness`, { cookie: examiner });
  check(data.papers >= 1, `papers ${data.papers}`);
});

// ------------------------------------------------------------------ live room
await step("live room stream sends a snapshot event", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${api}/exams/${exam.id}/monitor/stream`, { headers: { cookie: examiner, accept: "text/event-stream" }, signal: controller.signal });
    check(response.ok, `status ${response.status}`);
    check((response.headers.get("content-type") ?? "").includes("text/event-stream"), `content-type ${response.headers.get("content-type")}`);
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("event: snapshot")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    check(text.includes("event: snapshot"), "no snapshot event");
  } finally { clearTimeout(timer); controller.abort(); }
});
await step("candidate cannot open the live room stream", () =>
  request(`/exams/${exam.id}/monitor/stream`, { cookie: candidate, expect: [403, 404] }));

await step("bulk outage credit runs and reports counts", async () => {
  const now = Date.now();
  const { data } = await request(`/exams/${exam.id}/outage-credit`, { method: "POST", cookie: examiner, body: { from: iso(now - 30_000), to: iso(now), reason: "e2e window" } });
  check(typeof data.credited === "number" && typeof data.skipped === "number", JSON.stringify(data));
});

// ------------------------------------------------------------------ 5.4 disputes
await must("candidate answers (first one wrong) and submits", async () => {
  for (const [index, item] of attempt.items.entries()) {
    await request(`/attempts/${attempt.id}/answers/${item.id}`, { method: "PUT", cookie: candidate, headers: candidateHeaders,
      body: { response: { selected: [index === 0 ? "b" : "a"] }, flagged: false, clientSeq: index + 1 } });
  }
  return request(`/attempts/${attempt.id}/submit`, { method: "POST", cookie: candidate, headers: candidateHeaders, body: { confirm: true } });
});
await must("examiner completes the exam and publishes results", async () => {
  await request(`/exams/${exam.id}/complete?force=true`, { method: "POST", cookie: examiner, body: {} });
  return request(`/exams/${exam.id}/results/publish`, { method: "POST", cookie: examiner, body: {} });
});
const result = await must("candidate sees the result with item ids", async () => {
  const { data } = await request(`/me/results/${attempt.id}`, { cookie: candidate });
  check(data.breakdown?.[0]?.itemId, "breakdown rows need itemId for disputes");
  return data;
});
const wrongItem = attempt?.items?.[0]?.id;
const dispute = await must("candidate disputes the question marked wrong", async () => {
  const { data } = await request(`/attempts/${attempt.id}/disputes`, { method: "POST", cookie: candidate,
    body: { itemId: wrongItem, reason: "Both options can be read as correct; the stem is ambiguous." } });
  return data;
});
await step("a second dispute on the same question is refused (409)", () =>
  request(`/attempts/${attempt.id}/disputes`, { method: "POST", cookie: candidate, expect: 409,
    body: { itemId: wrongItem, reason: "Duplicate dispute for the same question." } }));
await step("examiner sees the dispute blind, with item marks and options", async () => {
  const { data } = await request(`/exams/${exam.id}/disputes?status=open`, { cookie: examiner });
  const row = data.find((item) => item.id === dispute.id);
  check(row, "dispute missing from the queue");
  check(row.scriptLabel && !JSON.stringify(row).includes("Phase Two"), "queue must be blind");
  check(row.itemMarks === 2 && Array.isArray(row.options), `itemMarks/options: ${JSON.stringify(row).slice(0, 240)}`);
});
await step("examiner accepts option B as an alternative; the score rises", async () => {
  const { data } = await request(`/disputes/${dispute.id}/resolve`, { method: "POST", cookie: examiner, body: {
    status: "accepted", resolution: "accept_alternative", response: "Agreed: B is also a correct reading.", alternativeOptionIds: ["b"] } });
  check(data.scoreAfter > data.scoreBefore, `before ${data.scoreBefore} after ${data.scoreAfter}`);
});
await step("the certificate still verifies after resolution", async () => {
  const { data } = await request(`/verify/${result.verifyCode}`);
  check(data.valid === true && data.signature?.valid === true, JSON.stringify(data).slice(0, 240));
});

// ------------------------------------------------------------------ AI grading assistant
await step("AI suggestion works, or reports NOT_CONFIGURED without a key", async () => {
  const { data: exams } = await request("/exams", { cookie: examiner });
  const finalExam = exams.items.find((item) => item.title === "Databases Final");
  check(finalExam, "Databases Final not found (run the demo seed)");
  const { data: queue } = await request(`/exams/${finalExam.id}/grading`, { cookie: examiner });
  check(queue.length > 0, "no written answers to suggest for");
  const { status, json } = await request(`/attempts/${queue[0].attemptId}/answers/${queue[0].itemId}/suggest`, { method: "POST", cookie: examiner, expect: [200, 404, 503] });
  if (status === 200) check(json.data.suggestedMarks <= json.data.maxMarks, JSON.stringify(json.data));
  else check(json?.error?.code === "NOT_CONFIGURED", `unexpected ${status} ${JSON.stringify(json).slice(0, 160)}`);
});

const failed = results.filter((item) => item.status === "fail").length;
const skipped = results.filter((item) => item.status === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
