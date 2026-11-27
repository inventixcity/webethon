import { Visitor } from '../lib/client.mjs';
import { stormAccounts } from '../lib/accounts.mjs';
import { BUDGETS, atLeast, atMost, check, exactly } from '../lib/budgets.mjs';
import { Pacer, mapLimit, sleep } from '../lib/pool.mjs';
import { Recorder, summarize } from '../lib/stats.mjs';

export const id = 'auth-storm';
export const title = '3. auth storm: 500 wrong-password sign-ins, 100 accounts, 50 IPs';

const WRONG_PASSWORD = 'Wrong password 123!';

// The budgets are 20 sign-ins per IP and 8 per account per 15 minutes (kernel/src/security.rs). Spreading 500
// attempts evenly over 50 IPs and 100 accounts would stay under both, so the storm concentrates attempts on a
// known subset to reach each budget, and keeps the rest as background traffic that must never be limited:
//   phase ip:          5 hot IPs x 30 attempts against cold accounts     -> 20 pass, 10 limited per IP (50)
//   phase account:     5 hot accounts x 20 attempts from cold IPs         -> 8 pass, 12 limited per account (60)
//   phase background:  250 attempts spread over cold accounts and IPs     -> none limited
// Every cold account stays under 8 and every cold IP under 20, so only the intended budgets fire.
export async function run({ log }) {
  const accounts = await stormAccounts(100, { log });
  const hot = accounts.slice(0, 5);
  const cold = accounts.slice(5);
  const hotIps = Array.from({ length: 5 }, () => new Visitor());
  const coldIps = Array.from({ length: 45 }, () => new Visitor());

  const attempts = [];
  let coldAccount = 0;
  let coldIp = 0;
  for (const visitor of hotIps) {
    for (let j = 0; j < 30; j++) attempts.push({ phase: 'ip', visitor, account: cold[coldAccount++ % cold.length] });
  }
  for (const account of hot) {
    for (let j = 0; j < 20; j++) attempts.push({ phase: 'account', visitor: coldIps[coldIp++ % coldIps.length], account });
  }
  for (let j = 0; j < 250; j++) {
    attempts.push({ phase: 'background', visitor: coldIps[coldIp++ % coldIps.length], account: cold[coldAccount++ % cold.length] });
  }
  shuffle(attempts); // phases interleave, as in a real storm; the expected counts do not depend on order

  // Health probes run from a few IPs (5 requests/s each) for the whole storm window.
  const probeVisitors = Array.from({ length: 4 }, () => new Visitor());
  const probes = [];
  let stopProbes = false;
  const probing = Promise.all(
    probeVisitors.map(async visitor => {
      const pacer = new Pacer(200);
      while (!stopProbes) {
        await pacer.turn();
        const startedAt = performance.now();
        const response = await visitor.send('GET', '/api/v1/health');
        probes.push({ startedAt, response });
      }
    }),
  );
  await sleep(500);

  log(`  ${attempts.length} sign-in attempts, 50 in flight`);
  const recorder = new Recorder();
  const stormStart = performance.now();
  const results = await mapLimit(attempts, 50, async attempt => {
    const response = await attempt.visitor.send('POST', '/api/v1/auth/signin', {
      body: { email: attempt.account.email, password: WRONG_PASSWORD },
    });
    recorder.record('signin', response);
    return { ...attempt, response };
  });
  recorder.stop();
  const stormEnd = performance.now();
  await sleep(300);
  stopProbes = true;
  await probing;

  const during = probes.filter(probe => probe.startedAt >= stormStart && probe.startedAt <= stormEnd);
  const healthLatency = summarize(during.map(probe => probe.response.ms));
  const healthNon200 = during.filter(probe => probe.response.status !== 200).length;

  const perPhase = Object.fromEntries(['ip', 'account', 'background'].map(phase => [phase, { accepted: 0, limited: 0, other: 0, missingRetryAfter: 0 }]));
  for (const { phase, response } of results) {
    const bucket = perPhase[phase];
    if (response.status === 401 && response.code === 'INVALID_CREDENTIALS') bucket.accepted++;
    else if (response.status === 429 && response.code === 'RATE_LIMITED') {
      bucket.limited++;
      if (!(response.retryAfter > 0)) bucket.missingRetryAfter++;
    } else bucket.other++;
  }
  const accepted = Object.values(perPhase).reduce((sum, bucket) => sum + bucket.accepted, 0);
  const limited = Object.values(perPhase).reduce((sum, bucket) => sum + bucket.limited, 0);
  const other = Object.values(perPhase).reduce((sum, bucket) => sum + bucket.other, 0);
  const missingRetryAfter = Object.values(perPhase).reduce((sum, bucket) => sum + bucket.missingRetryAfter, 0);

  const summary = recorder.summary();
  return {
    id,
    title,
    summary,
    checks: [
      exactly('limited by the per-IP budget (phase ip)', perPhase.ip.limited, 50),
      exactly('limited by the per-account budget (phase account)', perPhase.account.limited, 60),
      exactly('no limits on background traffic', perPhase.background.limited, 0),
      exactly('wrong-password responses (INVALID_CREDENTIALS)', accepted, BUDGETS.auth.expectedAccepted401),
      exactly('total 429 responses', limited, BUDGETS.auth.expectedRateLimited),
      atMost('responses that are neither 401 nor 429', other, 0),
      atMost('429 responses without a positive Retry-After', missingRetryAfter, 0),
      atMost('health p95 during the storm', healthLatency.p95, BUDGETS.auth.healthP95Ms, ' ms'),
      atMost('health responses that are not 200 during the storm', healthNon200, BUDGETS.auth.healthMaxNon200),
      atLeast('health samples during the storm', during.length, 20),
    ],
    notes: [
      `accounts: ${accounts.length} verified (${hot.length} hot); IPs: ${hotIps.length} hot + ${coldIps.length} cold`,
      `storm wall time: ${Math.round(stormEnd - stormStart)} ms; sign-in latency p50 ${summary.latency.p50} ms, p95 ${summary.latency.p95} ms`,
      `health during storm: p50 ${healthLatency.p50} ms, p95 ${healthLatency.p95} ms, p99 ${healthLatency.p99} ms, max ${healthLatency.max} ms (${during.length} samples)`,
      `health non-200 outcomes during storm: ${JSON.stringify(outcomeCounts(during.filter(probe => probe.response.status !== 200).map(probe => probe.response)))}`,
      `per phase, accepted/limited: ip ${perPhase.ip.accepted}/${perPhase.ip.limited}, account ${perPhase.account.accepted}/${perPhase.account.limited}, background ${perPhase.background.accepted}/${perPhase.background.limited}`,
      `all outcomes: ${JSON.stringify(summary.outcomes)}`,
      `hot IPs and their outcomes: ${hotIps.map(visitor => `${visitor.ip}=${JSON.stringify(outcomeCounts(results.filter(item => item.phase === 'ip' && item.visitor === visitor).map(item => item.response)))}`).join('; ')}`,
      `hot accounts (signin:acct keys): ${hot.map(account => account.email).join(', ')}`,
      ...(other ? [`first unexpected response: ${JSON.stringify(results.find(item => !(item.response.status === 401 || item.response.status === 429))?.response.code ?? null)} (status ${results.find(item => !(item.response.status === 401 || item.response.status === 429))?.response.status})`] : []),
    ],
  };
}

function outcomeCounts(responses) {
  const counts = {};
  for (const response of responses) {
    const key = `${response.status}${response.code ? ` ${response.code}` : ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}
