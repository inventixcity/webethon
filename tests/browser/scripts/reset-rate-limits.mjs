#!/usr/bin/env node
// Clears the API's rate-limit counters in the LOCAL development database, so the browser suite can create
// accounts beyond the per-IP sign-up budget. Only for disposable local stacks. Never point this at production.
//
// Usage: RATE_LIMIT_RESET_CMD="node scripts/reset-rate-limits.mjs" (set by README.md, read by lib/session.mjs)
//
// Environment:
//   RATE_LIMIT_CONTAINER  Postgres container name (default invigil-postgres-1, from docker-compose.yml)
//   RATE_LIMIT_DB         database name (default invigil)
//   RATE_LIMIT_DB_USER    database user (default postgres)
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const container = process.env.RATE_LIMIT_CONTAINER || "invigil-postgres-1";
const database = process.env.RATE_LIMIT_DB || "invigil";
const user = process.env.RATE_LIMIT_DB_USER || "postgres";
const deadline = Date.now() + 60_000;

async function docker(args) {
  return run("docker", ["exec", container, ...args], { timeout: 15_000 });
}

// Postgres can be briefly unavailable (crash recovery after a restart), so wait for it rather than failing.
for (;;) {
  try {
    await docker(["pg_isready", "-U", user, "-d", database]);
    break;
  } catch (error) {
    if (Date.now() > deadline) {
      console.error(`Postgres in ${container} is not accepting connections: ${error.stderr || error.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

await docker(["psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-c", "truncate rate_limits"]);
