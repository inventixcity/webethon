# Inventix Invigil

Invigil is a secure online examination system. Examiners author, schedule, monitor and grade exams; candidates complete timed attempts and receive verifiable results.

## Requirements

| Requirement | Invigil support |
|---|---|
| 3.1–3.8 | Role-based accounts, question authoring/import, exam setup/review, candidate enrollment, timed workspaces, resilient answer saves, privacy-light integrity indicators, grading/results and analytics |
| 4.1–4.8 | Argon2id passwords, server sessions/MFA support, server-side ownership checks, audited examiner/admin changes, strict validation, transactional state changes, rate limits and signed result verification |
| 5.1 | Watermarks, optional canaries and review indicators support integrity review in AI-era exams; signals are not evidence or verdicts |
| 5.3 | Server-clock deadlines, signed leases, a hash-chained client journal, idempotent submission and audited time credits support recovery from outages without pausing time |

## Stack

Rust, Axum and SQLx keep authorization and state transitions at the API boundary; PostgreSQL stores durable exam state. Next.js 16 and React provide the responsive web client and same-origin API proxy. The API deploys to Azure Container Apps and the web app to Vercel.

## Local setup

Prerequisites: Docker, Node 24 with pnpm, and Git Bash on Windows. Rust commands run through the Docker wrapper.

```bash
docker compose up -d postgres mailpit
docker compose up -d --build api
docker compose exec api /app/api seed-demo
cd web
printf 'API_ORIGIN=http://localhost:8080\nNEXT_PUBLIC_API_ENABLED=true\n' > .env.local
pnpm install
pnpm dev
```

The web app is at `http://localhost:3000`; Mailpit is at `http://localhost:8025`. Run backend checks with `cd backend && bash scripts/cargo.sh check -p server`. Demo accounts: `admin@invigil.app`, `examiner@invigil.app`, and `candidate@invigil.app`; password `Invigil#Demo2026`.

## Configuration

API: `DATABASE_URL`, `APP_ENV`, `APP_ORIGIN`, `PROXY_SECRET`, `TRUSTED_PROXY_HOPS`, `CODE_PEPPER`, `EXAM_LEASE_KEY`, `RESULT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `SMTP_URL` or `RESEND_API_KEY`, `EMAIL_FROM`, and `RUN_MIGRATIONS`. Optional grading suggestions use `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`. Production requires `EXAM_LEASE_KEY` (32+ characters) and `RESULT_SIGNING_KEY` (base64 of exactly 32 bytes).

Web: `API_ORIGIN`, `PROXY_SECRET`, `NEXT_PUBLIC_API_ENABLED=true`, and optionally `SITE_URL`. In Vercel, configure these with `vercel env add API_ORIGIN`, `vercel env add PROXY_SECRET`, and `vercel env add NEXT_PUBLIC_API_ENABLED`.

## Deployment and verification

Set the listed secrets in the ignored root `.env.production`, then run `deploy/azure/deploy.sh <APP_ORIGIN>` after `az login`. The script builds in Azure Container Registry and prints the API FQDN. Run `deploy/azure/seed.sh` to seed demo accounts. The web client deploys through Vercel.

Run the end-to-end flow against a seeded, running API with `API_URL=http://localhost:8080 node tests/e2e/exam-flow.mjs`. Web checks are `cd web && pnpm typecheck && pnpm test && pnpm build`.

## Innovation

5.3 keeps answers recoverable without trusting the client clock or granting automatic outage time. 5.1 provides privacy-light signals and leak tracing for examiner review, while keeping human judgment authoritative. See [docs/INNOVATION.md](docs/INNOVATION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/SECURITY.md](docs/SECURITY.md).
