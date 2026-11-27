// Invigil end-to-end exam flow against a running API. Plain Node 24 (fetch), no dependencies.
//
//   API_URL=http://localhost:8080 node tests/e2e/exam-flow.mjs
//
// Needs the demo account (`api seed-demo`): examiner@invigil.app,
// password Invigil#Demo2026 (override with EXAMINER_EMAIL and DEMO_PASSWORD).
// Every step runs and is reported; the process exits 1 if any step or check failed.

import { randomUUID } from "node:crypto";

const base = (process.env.API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const api = `${base}/api/v1`;
const password = process.env.DEMO_PASSWORD ?? "Invigil#Demo2026";
const examinerEmail = process.env.EXAMINER_EMAIL ?? "examiner@invigil.app";
const device = `e2e_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

const results = [];
let aborted = false;

class StepError extends Error {}

/** Runs one named step. A failed step is recorded; later steps that need its output are skipped. */
async function step(name, fn) {
  if (aborted) {
    results.push({ name, status: "skip" });
    console.log(`  SKIP  ${name}`);
    return undefined;
  }
  try {
    const value = await fn();
    results.push({ name, status: "pass" });
    console.log(`  PASS  ${name}`);
    return value;
  } catch (error) {
    results.push({ name, status: "fail", error: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
    return undefined;
  }
}

/** A step whose output later steps depend on: on failure, the rest of the flow is skipped. */
async function must(name, fn) {
  const before = results.length;
  const value = await step(name, fn);
  if (results[before]?.status === "fail") aborted = true;
  return value;
}

function check(condition, message) {
  if (!condition) throw new StepError(message);
}

/** Non-fatal contract findings (e.g. a missing {data} envelope): reported, but the flow continues. */
const warnings = [];

async function request(path, { method = "GET", body, cookie, headers = {}, expect } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  const acceptable = expect === undefined ? null : [expect].flat();
  const ok = acceptable ? acceptable.includes(response.status) : response.ok;
  if (!ok) {
    const wanted = acceptable ? acceptable.join(" or ") : "2xx";
    throw new StepError(`${method} ${path} -> ${response.status} (expected ${wanted}): ${text.slice(0, 600)}`);
  }
  let data = json;
  if (response.ok && json && typeof json === "object" && !Array.isArray(json)) {
    if ("data" in json) {
      data = json.data;
    } else {
      warnings.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, "{id}")}: success body is not wrapped in {data}`);
    }
  } else if (response.ok && Array.isArray(json)) {
    warnings.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, "{id}")}: success body is a bare array, not {data}`);
  }
  return { status: response.status, data, json, cookies: response.headers.getSetCookie() };
}

const cookieHeader = (cookies) => cookies.map((value) => value.split(";", 1)[0]).join("; ");

async function signIn(email) {
  const result = await request("/auth/signin", { method: "POST", body: { email, password } });
  const cookie = cookieHeader(result.cookies);
  check(cookie, `signin for ${email} did not set a session cookie`);
  return cookie;
}

const candidateHeaders = { "X-Attempt-Device": device };

console.log(`Invigil e2e against ${api}\n`);

await step("health endpoint reports ok", async () => {
  const { data } = await request("/health");
  check(data?.status === "ok", `health returned ${JSON.stringify(data)}`);
});

const examiner = await must("examiner signs in", () => signIn(examinerEmail));

await step("unauthenticated request to a candidate endpoint is refused (401)", () =>
  request("/me/exams", { expect: 401 }),
);

const q1 = await must("examiner creates a single-choice question", async () => {
  const { data } = await request("/questions", {
    method: "POST",
    cookie: examiner,
    body: {
      topic: "E2E arithmetic",
      difficulty: 1,
      kind: "single",
      stem: "What is 2 + 2?",
      options: [
        { id: "a", text: "4" },
        { id: "b", text: "5" },
        { id: "c", text: "22" },
      ],
      correct: ["a"],
      marks: 2,
      negativeMarks: 0,
      multiRule: "all_or_nothing",
      rubric: "",
      maxWords: null,
      explanation: "Two plus two is four.",
    },
  });
  check(data?.id, `question has no id: ${JSON.stringify(data)}`);
  return data;
});

const q2 = await must("examiner creates a written question", async () => {
  const { data } = await request("/questions", {
    method: "POST",
    cookie: examiner,
    body: {
      topic: "E2E reasoning",
      difficulty: 2,
      kind: "written",
      stem: "Explain why addition is commutative, in one sentence.",
      options: [],
      correct: [],
      marks: 3,
      negativeMarks: 0,
      multiRule: "all_or_nothing",
      rubric: "Full marks for stating that order does not change the sum.",
      maxWords: 100,
      explanation: "",
    },
  });
  check(data?.id, `question has no id: ${JSON.stringify(data)}`);
  return data;
});

await step("question validation rejects bad input (422)", () =>
  request("/questions", {
    method: "POST",
    cookie: examiner,
    body: { topic: "", difficulty: 9, kind: "single", stem: "", options: [], correct: [], marks: 1, maxWords: null },
    expect: 422,
  }),
);

const now = Date.now();
const exam = await must("examiner creates an exam", async () => {
  const { data } = await request("/exams", {
    method: "POST",
    cookie: examiner,
    body: {
      title: `E2E exam ${new Date(now).toISOString()}`,
      instructions: "Automated end-to-end exam.",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 2 * 3_600_000).toISOString(),
      durationMinutes: 30,
      totalMarks: 5,
      passMarks: 2,
      settings: {
        shuffleQuestions: true,
        shuffleOptions: true,
        allowOfflineJournal: true,
        lateJoinMinutes: null,
        showBreakdown: true,
        integrity: { watermark: true, canary: false, fullscreen: false },
      },
    },
  });
  check(data?.id, `exam has no id: ${JSON.stringify(data)}`);
  return data;
});

await must("examiner assigns both questions", async () => {
  const { data } = await request(`/exams/${exam.id}/questions`, {
    method: "PUT",
    cookie: examiner,
    body: { items: [{ questionId: q1.id }, { questionId: q2.id }] },
  });
  check(data?.questions?.length === 2, `exam has ${data?.questions?.length} questions after assign`);
});

await step("review checklist is ready", async () => {
  const { data } = await request(`/exams/${exam.id}/review`, { cookie: examiner });
  check(data?.ready === true, `review not ready: ${JSON.stringify(data?.checks ?? data)}`);
});

await must("examiner publishes the exam", async () => {
  const { data } = await request(`/exams/${exam.id}/publish`, { method: "POST", cookie: examiner });
  check(data?.status === "published", `status after publish is ${data?.status}`);
});

const candidateEmail = `e2e-${randomUUID().slice(0, 8)}@invigil.app`;
const inviteToken = await must("examiner enrolls a new candidate and gets an invite link", async () => {
  const { data } = await request(`/exams/${exam.id}/enrollments`, {
    method: "POST",
    cookie: examiner,
    body: { candidates: [{ email: candidateEmail, displayName: "E2E Candidate" }], invite: true, dryRun: false },
  });
  check(!data?.errors?.length, `enrollment errors: ${JSON.stringify(data?.errors)}`);
  const url = data?.inviteLinks?.find((link) => link.email === candidateEmail)?.url;
  check(url, `no invite link returned: ${JSON.stringify(data)}`);
  return new URL(url).pathname.split("/").at(-1);
});

await step("invite lookup shows the candidate's email", async () => {
  const { data } = await request(`/auth/invites/${encodeURIComponent(inviteToken)}`);
  check(data?.email === candidateEmail, `invite lookup returned ${JSON.stringify(data)}`);
});

const candidate = await must("candidate accepts the invite and is signed in", async () => {
  const result = await request("/auth/invites/accept", {
    method: "POST",
    body: { token: inviteToken, password: `${password}-e2e`, displayName: "E2E Candidate" },
  });
  const cookie = cookieHeader(result.cookies);
  check(cookie, "invite acceptance did not set a session cookie");
  return cookie;
});

await step("an accepted invite cannot be reused (404)", () =>
  request("/auth/invites/accept", {
    method: "POST",
    body: { token: inviteToken, password: `${password}-again`, displayName: "Someone Else" },
    expect: 404,
  }),
);

await step("candidate cannot list examiner questions (404)", () =>
  request("/questions", { cookie: candidate, expect: 404 }),
);

await step("candidate cannot read examiner exam detail (404)", () =>
  request(`/exams/${exam.id}`, { cookie: candidate, expect: 404 }),
);

await step("candidate cannot read examiner grading queue (404)", () =>
  request(`/exams/${exam.id}/grading`, { cookie: candidate, expect: 404 }),
);

await step("candidate cannot modify examiner question assignments (404)", () =>
  request(`/exams/${exam.id}/questions`, {
    method: "PUT",
    cookie: candidate,
    body: { items: [] },
    expect: 404,
  }),
);

await step("candidate dashboard lists the exam as available", async () => {
  const { data } = await request("/me/exams", { cookie: candidate });
  const card = data?.available?.find((item) => item.examId === exam.id);
  check(card, `exam not in available: ${JSON.stringify(data)}`);
});

const attemptId = await must("candidate starts the attempt", async () => {
  const { data } = await request(`/me/exams/${exam.id}/attempt`, {
    method: "POST",
    cookie: candidate,
    headers: candidateHeaders,
  });
  check(data?.attemptId, `no attemptId: ${JSON.stringify(data)}`);
  return data.attemptId;
});

await step("a second start returns the same attempt", async () => {
  const { data } = await request(`/me/exams/${exam.id}/attempt`, {
    method: "POST",
    cookie: candidate,
    headers: candidateHeaders,
  });
  check(data?.attemptId === attemptId, `second start returned ${data?.attemptId}, first ${attemptId}`);
});

const attempt = await must("candidate loads the attempt (no answer keys)", async () => {
  const { data, json } = await request(`/attempts/${attemptId}`, { cookie: candidate, headers: candidateHeaders });
  check(data?.items?.length === 2, `attempt has ${data?.items?.length} items`);
  check(data.deviceActive === true, "this device does not hold the attempt");
  const raw = JSON.stringify(json);
  for (const secret of ['"correct"', '"rubric"', '"explanation"', "Two plus two is four", "order does not change"]) {
    check(!raw.includes(secret), `attempt payload leaks ${secret}`);
  }
  return data;
});

await step("examiner cannot load the candidate's attempt (404)", () =>
  request(`/attempts/${attemptId}`, { cookie: examiner, headers: { "X-Attempt-Device": "examiner_device_1" }, expect: 404 }),
);

const single = attempt?.items?.find((item) => item.kind === "single");
const written = attempt?.items?.find((item) => item.kind === "written");
const rightOption = single?.options?.find((option) => option.text === "4")?.id;
const wrongOption = single?.options?.find((option) => option.text === "5")?.id;

await must("candidate saves answers", async () => {
  check(single && written && rightOption, "attempt items are missing the expected questions");
  const first = await request(`/attempts/${attemptId}/answers/${single.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: candidateHeaders,
    body: { response: { selected: [rightOption] }, flagged: false, clientSeq: 1 },
  });
  check(first.data?.accepted === true, `single save not accepted: ${JSON.stringify(first.data)}`);
  const second = await request(`/attempts/${attemptId}/answers/${written.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: candidateHeaders,
    body: {
      response: { text: "Addition is commutative because swapping the order of the numbers does not change the sum." },
      flagged: true,
      clientSeq: 2,
      typing: { keystrokes: 90, pastes: 0, pastedChars: 0, activeMs: 40_000 },
    },
  });
  check(second.data?.accepted === true, `written save not accepted: ${JSON.stringify(second.data)}`);
});

await step("a stale save (lower clientSeq) is ignored", async () => {
  const { data } = await request(`/attempts/${attemptId}/answers/${single.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: candidateHeaders,
    body: { response: { selected: [wrongOption] }, flagged: false, clientSeq: 0 },
  });
  check(data?.accepted === false, `stale save was accepted: ${JSON.stringify(data)}`);
});

await step("a save from another device is refused (409)", () =>
  request(`/attempts/${attemptId}/answers/${single.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: { "X-Attempt-Device": "other_device_99" },
    body: { response: { selected: [rightOption] }, flagged: false, clientSeq: 10 },
    expect: 409,
  }),
);

await step("an invalid option id is rejected (422)", () =>
  request(`/attempts/${attemptId}/answers/${single.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: candidateHeaders,
    body: { response: { selected: ["nope"] }, flagged: false, clientSeq: 11 },
    expect: 422,
  }),
);

await step("saved answers come back on reload", async () => {
  const { data } = await request(`/attempts/${attemptId}`, { cookie: candidate, headers: candidateHeaders });
  const saved = data?.answers?.find((answer) => answer.itemId === single.id);
  check(saved?.response?.selected?.[0] === rightOption, `reloaded answer is ${JSON.stringify(saved)}`);
});

const submittedAt = await must("candidate submits", async () => {
  const { data } = await request(`/attempts/${attemptId}/submit`, {
    method: "POST",
    cookie: candidate,
    body: { confirm: true },
  });
  check(data?.status === "submitted", `status after submit is ${data?.status}`);
  return data.submittedAt;
});

await step("a second submit is idempotent", async () => {
  const { data } = await request(`/attempts/${attemptId}/submit`, {
    method: "POST",
    cookie: candidate,
    body: { confirm: true },
  });
  check(data?.status === "submitted" && data?.submittedAt === submittedAt, `second submit returned ${JSON.stringify(data)}`);
});

await step("a save after submit is refused (409)", () =>
  request(`/attempts/${attemptId}/answers/${single.id}`, {
    method: "PUT",
    cookie: candidate,
    headers: candidateHeaders,
    body: { response: { selected: [rightOption] }, flagged: false, clientSeq: 20 },
    expect: 409,
  }),
);

await step("results cannot be published while the window is open (409)", () =>
  request(`/exams/${exam.id}/results/publish`, { method: "POST", cookie: examiner, expect: 409 }),
);

const pending = await must("examiner lists the written answer for grading", async () => {
  const { data } = await request(`/exams/${exam.id}/grading?pending=true`, { cookie: examiner });
  check(Array.isArray(data), `grading list is not an array: ${JSON.stringify(data)}`);
  const mine = data.filter((item) => item.attemptId === attemptId);
  check(mine.length === 1, `expected 1 pending written answer, got ${mine.length}`);
  check(!JSON.stringify(mine).includes(candidateEmail), "grading list reveals the candidate (blind grading)");
  return mine;
});

await step("grading rejects marks above the item maximum (422)", () =>
  request(`/attempts/${attemptId}/answers/${pending[0].itemId}/grade`, {
    method: "PUT",
    cookie: examiner,
    body: { marks: 99, feedback: "" },
    expect: 422,
  }),
);

await must("examiner grades the written answer", async () => {
  for (const item of pending) {
    const { data } = await request(`/attempts/${item.attemptId}/answers/${item.itemId}/grade`, {
      method: "PUT",
      cookie: examiner,
      body: { marks: 2.5, feedback: "Clear, but name the property." },
    });
    check(data?.manualMarks === 2.5, `grade returned ${JSON.stringify(data)}`);
  }
});

await must("examiner completes the exam", async () => {
  const { data } = await request(`/exams/${exam.id}/complete?force=true`, { method: "POST", cookie: examiner });
  check(data?.status === "completed", `status after complete is ${data?.status}`);
});

await step("candidate cannot see the result before publication (404)", () =>
  request(`/me/results/${attemptId}`, { cookie: candidate, expect: 404 }),
);

await must("examiner publishes results", async () => {
  const { data } = await request(`/exams/${exam.id}/results/publish`, { method: "POST", cookie: examiner });
  check(data?.resultsPublishedAt, `results not published: ${JSON.stringify(data)}`);
  const row = data.rows?.find((r) => r.attemptId === attemptId);
  check(row?.totalScore === 4.5, `total score is ${row?.totalScore}, expected 4.5`);
});

const verifyCode = await must("candidate sees the published result", async () => {
  const { data } = await request(`/me/results/${attemptId}`, { cookie: candidate });
  check(data?.totalScore === 4.5 && data?.passed === true, `result: ${JSON.stringify(data)}`);
  check(data?.verifyCode, "result has no verify code");
  check(Array.isArray(data?.breakdown) && data.breakdown.length === 2, "breakdown missing (showBreakdown is on)");
  return data.verifyCode;
});

await step("examiner sees analytics for the exam", async () => {
  const { data } = await request(`/exams/${exam.id}/analytics`, { cookie: examiner });
  check(data?.submitted >= 1, `analytics: ${JSON.stringify(data)?.slice(0, 300)}`);
});

await must("public verify confirms the certificate", async () => {
  const { data } = await request(`/verify/${encodeURIComponent(verifyCode)}`);
  check(data?.valid === true && data?.revoked === false, `verify: ${JSON.stringify(data)}`);
  check(data?.signature?.algorithm === "Ed25519" && data.signature.valid === true, "signature not valid");
  check(!JSON.stringify(data).includes(candidateEmail), "verify response reveals the candidate's email");
});

await step("a tampered verify code is invalid", async () => {
  const last = verifyCode.at(-1);
  const altered = `${verifyCode.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  const { data } = await request(`/verify/${encodeURIComponent(altered)}`, { expect: [200, 404] });
  check(!data || data.valid === false, `tampered code verified: ${JSON.stringify(data)}`);
});

await step("a malformed verify code does not crash the server", async () => {
  await request(`/verify/${encodeURIComponent("ÄÄÄÄ-ÄÄÄÄ-ÄÄÄÄ")}`, { expect: [200, 404, 422] });
  await request("/health");
});

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
const passed = results.filter((r) => r.status === "pass");
console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (warnings.length) {
  console.log(`\nContract warnings (${new Set(warnings).size}):`);
  for (const warning of new Set(warnings)) console.log(`  - ${warning}`);
}
if (exam?.id) console.log(`\nexam ${exam.id}${attemptId ? ` attempt ${attemptId}` : ""}`);
process.exit(failed.length || warnings.length ? 1 : 0);
