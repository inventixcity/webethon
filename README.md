# Inventix Invigil

Inventix Invigil is a secure online examination system. Examiners author and run exams, monitor attempts, grade responses, and publish verifiable results. Candidates take timed exams with resilient answer saving.

## Requirements coverage

- **3.1–3.8:** question bank/import, exam authoring/review, enrollment/invitations, timed delivery, resilient attempt journal, integrity indicators, grading/results, analytics.
- **4.1–4.8:** role-based access, password hashing and sessions, MFA support, audited examiner/admin changes, strict validation, transactional state changes, rate limits, signed result verification.
- **5.1:** integrity signals support examiner review in AI-era exams; signals are indicators, not evidence.
- **5.3:** server-clock deadlines, idempotent submission, resumable attempts and a client answer journal support recovery from interruptions.

## Stack

Rust, Axum, SQLx and PostgreSQL keep authorization and state changes at the API boundary. Next.js 16 and React provide the web client. The web app runs on Vercel and the API on Azure Container Apps.

## Local setup

Start PostgreSQL with `docker compose up -d postgres`. Copy `.env.example` to `.env` and set local values. Run backend checks with `cd backend && bash scripts/cargo.sh check -p server`; run the web client from `web` with `pnpm install`, `pnpm dev`, and `pnpm typecheck`.

Demo accounts: `admin@invigil.app`, `examiner@invigil.app`, and `candidate@invigil.app`; password `Invigil#Demo2026` (available after demo seeding).

API configuration includes `DATABASE_URL`, `APP_ORIGIN`, `PROXY_SECRET`, `CODE_PEPPER`, `EXAM_LEASE_KEY`, `RESULT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, and `SMTP_URL` or `RESEND_API_KEY` with `EMAIL_FROM`. Optional AI grading uses `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`. Production requires a 32+ character lease key and a base64 encoded 32-byte result signing key.

## Deployment and checks

API deployment is scripted by `deploy/azure/deploy.sh` and builds in Azure. Demo seeding is available through `deploy/azure/seed.sh`. Configure the Vercel web project with `API_ORIGIN`, `PROXY_SECRET`, and `NEXT_PUBLIC_API_ENABLED=true` (for example, `vercel env add API_ORIGIN`, `vercel env add PROXY_SECRET`, and `vercel env add NEXT_PUBLIC_API_ENABLED`). Run the end-to-end exam flow with `API_URL=https://api.example node tests/e2e/exam-flow.mjs`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/INNOVATION.md](docs/INNOVATION.md).
