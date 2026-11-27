import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function paymentsEnvironment() {
  if (process.env.PAYMENTS_API_ORIGIN) return { origin: process.env.PAYMENTS_API_ORIGIN, cleanup() {} };
  const id = randomUUID().replaceAll('-', '');
  const db = `invigil_payments_e2e_${id}`;
  if (!/^invigil_payments_e2e_[a-f0-9]{32}$/.test(db)) throw new Error('Invalid isolated database name');
  const api = `payments-e2e-api-${id}`, mock = `payments-e2e-mock-${id}`;
  let databaseCreated = false;
  const cleanup = () => {
    for (const name of [mock, api]) { try { docker('rm', '-f', name); } catch {} }
    if (databaseCreated) { docker('exec', 'invigil-postgres-1', 'dropdb', '-U', 'postgres', '--if-exists', '--force', db); databaseCreated = false; }
  };
  try {
    docker('exec', 'invigil-postgres-1', 'createdb', '-U', 'postgres', db);
    databaseCreated = true;
    const image = process.env.PAYMENTS_E2E_IMAGE || 'invigil-rust:dev';
    const args = ['run', '-d', '--name', api, '--network', 'invigil_default', '-p', '127.0.0.1::8080',
      '-e', 'APP_ENV=development', '-e', 'BIND_ADDR=0.0.0.0:8080', '-e', `DATABASE_URL=postgres://postgres:postgres@postgres:5432/${db}`,
      '-e', 'SMTP_URL=smtp://mailpit:1025', '-e', 'RUN_MIGRATIONS=true', '-e', 'BREACH_CHECK=false',
      '-e', 'STRIPE_SECRET_KEY=sk_test_e2e', '-e', 'STRIPE_WEBHOOK_SECRET=whsec_e2e', '-e', 'STRIPE_API_BASE=http://127.0.0.1:12111'];
    if (!process.env.PAYMENTS_E2E_IMAGE) args.push('-v', `${resolve(root, 'backend')}:/work`, '-v', 'wa-cargo-registry:/usr/local/cargo/registry', '-v', 'wa-cargo-git:/usr/local/cargo/git', '-v', 'wa-target-run:/work/target', '-w', '/work', image, 'cargo', 'run', '--bin', 'api');
    else args.push(image);
    docker(...args);
    docker('run', '-d', '--name', mock, '--network', `container:${api}`, '-v', `${resolve(root, 'tests/e2e/lib')}:/mock:ro`, 'node:24-bookworm-slim', 'node', '/mock/stripe-mock.mjs');
    const port = docker('port', api, '8080/tcp').match(/:(\d+)$/)?.[1];
    if (!port) throw new Error('Could not determine isolated API port');
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      try {
        const replies = await Promise.all(['/healthz', '/readyz'].map(path => fetch(origin + path, { signal: AbortSignal.timeout(2000) })));
        if (replies.every(response => response.ok)) return { origin, cleanup };
      } catch {}
      await pause(1000);
    }
    throw new Error('Isolated payments API did not become healthy and ready within 240 seconds');
  } catch (err) { cleanup(); throw new Error('Could not provision isolated payments environment; check Docker availability and required images'); }
}

