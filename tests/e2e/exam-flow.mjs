import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const api = `${base}/api/v1`;

async function request(path, { method = 'GET', body, cookie, headers = {}, expected } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  else assert.ok(response.ok, `${method} ${path} returned ${response.status}: ${text}`);
  return { response, payload: payload.data ?? payload, cookies: response.headers.getSetCookie?.() ?? [] };
}
const cookieHeader = (cookies) => cookies.map((value) => value.split(';', 1)[0]).join('; ');
async function signIn(email, password) {
  const result = await request('/auth/signin', { method: 'POST', body: { email, password } });
  const cookie = cookieHeader(result.cookies);
  assert.ok(cookie, 'signin must set a session cookie');
  return cookie;
}

const examiner = await signIn(process.env.EXAMINER_EMAIL ?? 'examiner@invigil.app', process.env.DEMO_PASSWORD ?? 'Invigil#Demo2026');
const candidateEmail = `candidate-${randomUUID()}@invigil.app`;
const now = Date.now();
const q1 = (await request('/questions', { method: 'POST', cookie: examiner, body: {
  topic: 'e2e', difficulty: 1, kind: 'single', stem: 'Which value is correct?', options: [{ id: 'a', text: 'Correct' }, { id: 'b', text: 'Incorrect' }], correct: ['a'], marks: 1, negativeMarks: 0, multiRule: 'all_or_nothing', rubric: '', maxWords: null, explanation: '',
} })).payload;
const q2 = (await request('/questions', { method: 'POST', cookie: examiner, body: {
  topic: 'e2e', difficulty: 1, kind: 'written', stem: 'Explain the result briefly.', options: [], correct: [], marks: 1, negativeMarks: 0, multiRule: 'all_or_nothing', rubric: 'Award full credit for a clear explanation.', maxWords: 100, explanation: '',
} })).payload;
const exam = (await request('/exams', { method: 'POST', cookie: examiner, body: {
  title: `E2E ${randomUUID()}`, instructions: 'Automated exam flow.', startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), durationMinutes: 30, totalMarks: 2, passMarks: 1,
  settings: { shuffleQuestions: false, shuffleOptions: false, allowOfflineJournal: true, lateJoinMinutes: null, showBreakdown: true, integrity: { watermark: true, canary: false, fullscreen: false } },
} })).payload;
assert.ok(exam.id);
await request(`/exams/${exam.id}/questions`, { method: 'PUT', cookie: examiner, body: { items: [{ questionId: q1.id }, { questionId: q2.id }] } });
await request(`/exams/${exam.id}/publish`, { method: 'POST', cookie: examiner, body: {} });
const enrollment = (await request(`/exams/${exam.id}/enrollments`, { method: 'POST', cookie: examiner, body: { candidates: [{ email: candidateEmail, displayName: 'E2E Candidate' }], invite: true, dryRun: false } })).payload;
const inviteUrl = enrollment.inviteLinks?.find((item) => item.email === candidateEmail)?.url;
assert.ok(inviteUrl, 'new enrollment returns an invitation URL');
const token = new URL(inviteUrl).pathname.split('/').at(-1);
await request(`/auth/invites/${encodeURIComponent(token)}`);
const accept = await request('/auth/invites/accept', { method: 'POST', body: { token, password: process.env.DEMO_PASSWORD ?? 'Invigil#Demo2026', displayName: 'E2E Candidate' } });
const candidate = cookieHeader(accept.cookies);
assert.ok(candidate, 'invite acceptance sets a session cookie');
await request('/exams', { cookie: candidate, expected: 404 });
const device = 'e2e_device_123';
const start = (await request(`/me/exams/${exam.id}/attempt`, { method: 'POST', cookie: candidate, headers: { 'X-Attempt-Device': device }, body: {} })).payload;
const again = (await request(`/me/exams/${exam.id}/attempt`, { method: 'POST', cookie: candidate, headers: { 'X-Attempt-Device': device }, body: {} })).payload;
assert.equal(again.attemptId, start.attemptId);
const attemptId = start.attemptId;
const attempt = (await request(`/attempts/${attemptId}`, { cookie: candidate, headers: { 'X-Attempt-Device': device } })).payload;
for (const item of attempt.items) {
  await request(`/attempts/${attemptId}/answers/${item.id}`, { method: 'PUT', cookie: candidate, headers: { 'X-Attempt-Device': device }, body: {
    response: item.kind === 'written' ? { text: 'The result follows from the stated values.' } : { selected: ['a'] }, flagged: false, clientSeq: 1,
  } });
}
await request(`/attempts/${attemptId}/submit`, { method: 'POST', cookie: candidate, body: { confirm: true } });
await request(`/attempts/${attemptId}/answers/${attempt.items[0].id}`, { method: 'PUT', cookie: candidate, headers: { 'X-Attempt-Device': device }, body: { response: { selected: ['b'] }, flagged: false, clientSeq: 2 }, expected: 409 });
const pending = (await request(`/exams/${exam.id}/grading?pending=true`, { cookie: examiner })).payload;
for (const item of pending) await request(`/attempts/${item.attemptId}/answers/${item.itemId}/grade`, { method: 'PUT', cookie: examiner, body: { marks: 1, feedback: 'Reviewed by E2E.' } });
await request(`/exams/${exam.id}/results/publish`, { method: 'POST', cookie: examiner, body: {} });
const result = (await request(`/me/results/${attemptId}`, { cookie: candidate })).payload;
assert.ok(result.verifyCode);
const verified = (await request(`/verify/${encodeURIComponent(result.verifyCode)}`)).payload;
assert.equal(verified.valid, true);
const altered = `${result.verifyCode.slice(0, -1)}${result.verifyCode.endsWith('A') ? 'B' : 'A'}`;
assert.equal((await request(`/verify/${encodeURIComponent(altered)}`)).payload.valid, false);
console.log(`Exam flow passed for ${exam.id} / ${attemptId}`);
