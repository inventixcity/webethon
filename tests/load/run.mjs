// Load and resilience suite. Usage: node tests/load/run.mjs [--only=read-heavy,booking] [--soak]
//   [--duration=60] [--soak-duration=600] [--out=results.json]
// Reads API_URL (default http://127.0.0.1:8080), MAILPIT_URL and PROXY_SECRET from the environment.
import { writeFile } from 'node:fs/promises';
import { API_URL, MAILPIT_URL, PROXY_SECRET, RUN_ID } from './lib/config.mjs';

const SCENARIOS = {
  'read-heavy': () => import('./scenarios/read-heavy.mjs'),
  'write-heavy': () => import('./scenarios/write-heavy.mjs'),
  'auth-storm': () => import('./scenarios/auth-storm.mjs'),
  booking: () => import('./scenarios/booking.mjs'),
  sse: () => import('./scenarios/sse.mjs'),
  soak: () => import('./scenarios/soak.mjs'),
};
const DEFAULT = ['read-heavy', 'write-heavy', 'auth-storm', 'booking', 'sse'];

const args = Object.fromEntries(
  process.argv.slice(2).map(arg => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : true];
  }),
);

function fail(message, code = 2) {
  console.error(`\nerror: ${message}`);
  process.exit(code);
}

if (!PROXY_SECRET) {
  fail(
    'PROXY_SECRET is not set. The suite signs one client IP per simulated user, the same way the Next.js proxy does, ' +
      'so per-IP budgets behave as in production. Set it to the API\'s value; see tests/load/README.md.',
  );
}

const selected = typeof args.only === 'string' ? args.only.split(',').map(name => name.trim()) : [...DEFAULT, ...(args.soak ? ['soak'] : [])];
for (const name of selected) if (!(name in SCENARIOS)) fail(`unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);

const duration = Number(args.duration ?? 60);
const soakDuration = Number(args['soak-duration'] ?? 600);
const thinkMs = Number(args['think-ms'] ?? 2000);
if (!(duration > 0) || !(soakDuration > 0)) fail('--duration and --soak-duration must be positive numbers of seconds');
if (!(thinkMs >= 0)) fail('--think-ms must be zero or more');

const log = message => console.log(message);

// Preflight: the API must be ready, and Mailpit is needed to create accounts.
const ready = await fetch(`${API_URL}/readyz`, { signal: AbortSignal.timeout(5000) }).catch(error => ({ status: 0, error }));
if (ready.status !== 200) fail(`${API_URL}/readyz returned ${ready.status}. Is the API running and its database up?`);
const codeSource = process.env.CODE_SOURCE || 'mailpit';
if (codeSource === 'mailpit') {
  const mail = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(5000) }).catch(() => ({ ok: false }));
  if (!mail.ok) fail(`Mailpit is not reachable at ${MAILPIT_URL}. Set MAILPIT_URL to its origin, or CODE_SOURCE=api-log (see tests/load/README.md).`);
} else if (codeSource !== 'api-log') {
  fail(`CODE_SOURCE must be "mailpit" or "api-log", not "${codeSource}"`);
}

console.log(`Load suite  run ${RUN_ID}`);
console.log(`API         ${API_URL}`);
console.log(`Codes       ${codeSource === 'mailpit' ? `Mailpit at ${MAILPIT_URL}` : 'read from the API log (CODE_SOURCE=api-log)'}`);
console.log(`Signed IPs  yes (PROXY_SECRET set; one IP per simulated user)`);
console.log(`Scenarios   ${selected.join(', ')}`);

const results = [];
for (const name of selected) {
  const module = await SCENARIOS[name]();
  console.log(`\n== ${module.title} ==`);
  const started = Date.now();
  let result;
  try {
    result = await module.run({ duration: name === 'soak' ? soakDuration : duration, thinkMs, log });
  } catch (error) {
    result = { id: name, title: module.title, checks: [], error: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') };
  }
  result.wallSeconds = Math.round((Date.now() - started) / 1000);
  results.push(result);
  printResult(result);
}

printTable(results);
if (args.out) {
  await writeFile(args.out, JSON.stringify({ runId: RUN_ID, apiUrl: API_URL, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${args.out}`);
}
process.exitCode = results.every(result => !result.error && result.checks.every(item => item.pass)) ? 0 : 1;

function verdict(result) {
  if (result.error) return 'ERROR';
  return result.checks.every(item => item.pass) ? 'PASS' : 'FAIL';
}

function printResult(result) {
  if (result.error) console.log(`  ERROR: ${result.error}`);
  for (const item of result.checks) {
    const label = item.skipped ? 'SKIP' : item.pass ? 'PASS' : 'FAIL';
    const budget = item.budget ? `  budget ${item.budget}` : '';
    console.log(`  [${label}] ${item.name}: ${item.actual}${budget}`);
  }
  for (const note of result.notes ?? []) console.log(`  note: ${note}`);
  console.log(`  verdict ${verdict(result)} (${result.wallSeconds} s)`);
}

function printTable(all) {
  const rows = all.map(result => {
    const latency = result.latency ?? result.summary?.latency ?? {};
    const rps = result.rps ?? result.summary?.rps;
    const requests = result.requests ?? result.summary?.requests;
    const scored = result.checks.filter(item => !item.skipped);
    return {
      scenario: result.id,
      verdict: verdict(result),
      requests: requests ?? '-',
      rps: rps === undefined || rps === null ? '-' : Math.round(rps * 10) / 10,
      p50: latency.p50 ?? '-',
      p95: latency.p95 ?? '-',
      p99: latency.p99 ?? '-',
      checks: `${scored.filter(item => item.pass).length}/${scored.length}`,
    };
  });
  const headers = ['scenario', 'verdict', 'requests', 'rps', 'p50 ms', 'p95 ms', 'p99 ms', 'checks'];
  const keys = ['scenario', 'verdict', 'requests', 'rps', 'p50', 'p95', 'p99', 'checks'];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[keys[index]]).length)));
  const line = cells => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log('\nSummary');
  console.log(line(headers));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(keys.map(key => row[key])));
}
