# Inventix Invigil

**Exams that hold up.** Invigil is a secure online examination system. Admins manage users, examiners author,
run, monitor, grade and publish exams, and candidates sit timed attempts and receive verifiable results.

| | |
| --- | --- |
| Web app (production) | https://invigil-ivory.vercel.app |
| API (production) | https://invigil-api.onrender.com (liveness: `/healthz`) |
| Verify a certificate | https://invigil-ivory.vercel.app/verify |

> **Demo accounts exist only in the demonstration environment, which holds fictional data.** A real deployment
> never runs the demo seed. It provisions accounts individually (admin, then examiner invites, then candidate
> enrolment) and sets `NEXT_PUBLIC_DEMO_LOGINS=false`.

## Innovation

**5.3 Failure-resilient examinations (headline).** Answers are journaled on the candidate's device before they are
sent, so a dropped connection or a refresh loses nothing that was written on that device. The server owns the clock:
the deadline is fixed at start and never pauses. Each heartbeat returns an HMAC-signed lease, and a hash-chained
journal is verified on sync. Outages are measured from heartbeats the server actually received. Time is credited
only by an examiner, against a verified outage, capped and audited. Nothing is granted automatically. The honest
limit is that offline authorship time cannot be proven. The server bounds any gain to 90 s, only when the device was
verifiably offline at the deadline, and flags late-synced answers for review. Details and the threat table are in
[docs/INNOVATION.md](docs/INNOVATION.md).

**5.1 Integrity in the AI era.** Invigil collects privacy-light signals instead of webcams or screen capture: focus
loss, fullscreen exits, paste sizes, typing counts (never content) and device locks. These feed a review priority
for the examiner. Each stem can carry an invisible per-candidate watermark for leak tracing, and an opt-in AI canary
(off by default, hidden from assistive technology). A collusion screen lists pairs of candidates with many identical
wrong answers. Every signal is labelled as an indicator for human review. None changes a mark or blocks a candidate.

## Feature matrix

Requirement numbers follow the team brief. Each row names where the requirement is implemented. Routes are under
`/api/v1`.

| Req | Capability | Routes | Crates / pages |
| --- | --- | --- | --- |
| 3.1 | Role-based accounts (candidate, examiner, admin) | `/auth/*`, `/admin/users*` | `auth`, `admin`, `examcore` (role extractors) |
| 3.2 | Question bank, authoring, CSV import (dry run, all or nothing) | `/questions`, `/questions/import`, `/questions/{id}/stats` | `exam_questions`; `/app/examiner/questions` |
| 3.3 | Exam setup, review checklist, publish snapshot, sandbox preview | `/exams`, `/exams/{id}`, `/exams/{id}/questions`, `/exams/{id}/review`, `/publish`, `/sandbox` | `exam_authoring` |
| 3.4 | Candidate enrolment, invites, accommodations | `/exams/{id}/enrollments`, `/enrollments/{candidateId}/invite`, `/auth/invites/*` | `exam_enroll`; `/invite/[token]` |
| 3.5 | Timed, full-screen workspace with a server deadline | `/me/exams`, `/me/exams/{examId}`, `/me/exams/{examId}/attempt`, `/attempts/{id}` | `exam_attempts`; `/exam/[attemptId]` |
| 3.6 | Resilient answer saves (journal, leases, heartbeats, takeover) | `/attempts/{id}/answers/{itemId}`, `/heartbeat`, `/journal`, `/takeover`, `/outages`, `/time-credit` | `exam_attempts`, `exam_resilience` |
| 3.7 | Privacy-light integrity indicators and leak tracing | `/attempts/{id}/events`, `/attempts/{id}/integrity`, `/exams/{id}/monitor`, `/exams/{id}/announcements`, `/exams/{id}/trace` | `exam_integrity`; Monitor tab |
| 3.8 | Rubric and objective grading, results, PDF reports, analytics | `/exams/{id}/grading`, `/attempts/{id}/answers/{itemId}/grade`, `/exams/{id}/results*`, `/me/results/{attemptId}`, `/exams/{id}/analytics` | `exam_grading`, `exam_analytics`; `/api/reports/*`, `/verify/*` |
| 4.1 | Argon2id passwords, server sessions, MFA | `/auth/signin`, `/auth/session`, `/auth/sessions`, MFA routes | `auth`, `kernel` (sessions) |
| 4.2 | Ownership and role checks in SQL; 404 for hidden resources | every owner-scoped route | `examcore::load_exam_*`, `exam_*` |
| 4.3 | Audited examiner and admin changes | all state changes | `kernel::security::audit`; `/admin/audit` |
| 4.4 | Strict validation (`deny_unknown_fields`, ranges, 1 MiB bodies) | every JSON route | `server`, `kernel` |
| 4.5 | Transactions and row locks on attempt state | save, submit, journal, takeover, credit | `exam_attempts`, `exam_resilience` |
| 4.6 | Signed result verification (Ed25519 certificates) | `/exams/{id}/results/publish`, `/verify/{code}` | `exam_grading`, `examcore` (signer); `/verify` |
| 4.7 | Workspace preferences | `/me/prefs` | `exam_attempts` |
| 4.8 | Scratch work (text and sketch) | `/attempts/{id}/scratch` | `exam_attempts` |

Routers mounted by the API (`backend/crates/server/src/lib.rs`): `auth`, `admin`, the eight exam crates, and the health
endpoints. Upload, AI, and the social, teams, booking, payments and places product routers are **not mounted**.

## Stack and why

- **API:** Rust, Axum 0.8, SQLx 0.8 and PostgreSQL 17. Authorization, scoring, timing and every state transition live
  here, so the browser is never trusted. Rust keeps the many small invariants (row locks, typed inputs, no
  `unwrap` in handlers) cheap to enforce.
- **Web:** Next.js 16 (App Router), React 19, TypeScript strict and Tailwind 4. The browser calls a same-origin
  `/api/v1/*` proxy, so there is no CORS and the session cookie is first-party.
- **Database:** Supabase Postgres in production, with row-level security enabled on every table and the anon and
  authenticated grants revoked. The API connects as the table owner.
- **Hosting:** the API runs as an image built by GitHub Actions and pushed to GHCR, then run on Render. The web app
  runs on Vercel. Email goes through Resend from a verified domain.

## Local setup

Prerequisites: Docker, Node 22 or later with pnpm 9, and Git Bash on Windows.

```bash
# 1. Postgres and a local mail catcher
docker compose up -d postgres mailpit

# 2. The API (Rust builds inside Docker, so no local toolchain is needed)
docker compose up -d --build api
#    or run the same wrapper for cargo checks and tests:
bash backend/scripts/cargo.sh check -p server

# 3. Demo data (fictional accounts and exams)
docker compose run --rm api seed-demo

# 4. The web app
cd web
printf 'API_ORIGIN=http://localhost:8080\nNEXT_PUBLIC_API_ENABLED=true\nNEXT_PUBLIC_DEMO_LOGINS=true\n' > .env.local
pnpm install
pnpm dev
```

Open http://localhost:3000. Mailpit, which catches all outgoing email, is at http://localhost:8025. Postgres listens on
`127.0.0.1:55432`. The web proxy signs client IPs with `PROXY_SECRET`, so set the same value of 32+ characters for the
API (its environment) and the web app (`web/.env.local`). The compose file does not set one.

## Test credentials

Every demo account uses the password **`Invigil#Demo2026`**.

| Role | Email | Notes |
| --- | --- | --- |
| Admin | `admin@invigil.app` | User management, audit log, step-up for sensitive actions |
| Examiner | `examiner@invigil.app` | Owns the seeded exams: setup, monitor, grading, results |
| Examiner (second) | `examiner2@invigil.app` | Second owner, to check ownership isolation |
| Candidate | `candidate@invigil.app` | Enrolled in the demo exams |
| Candidate | `candidate01@invigil.app` to `candidate24@invigil.app` | Seeded candidates with varied attempts |

> **Warning:** these shared credentials exist only in the demonstration environment, and anyone with them can sign in.
> A real deployment never runs `seed-demo`. It provisions accounts individually and sets
> `NEXT_PUBLIC_DEMO_LOGINS=false`, which hides the demo sign-in buttons.

## Accounts and password reset

- **Self sign-up is off.** The API mounts sign-up routes only when `ALLOW_SELF_SIGNUP=true`, which production does not set.
- **Examiners** are created by an admin, who sends an invite with a one-time set-password link. Only the SHA-256 of the
  token is stored; the link expires after 7 days and works once.
- **Candidates** are enrolled by an examiner (CSV import or one at a time). Each receives an email invite.
- **Forgotten password.** The user requests a 6-digit code by email. The code expires after 15 minutes and is locked
  after 5 wrong attempts. The forgot-password endpoint returns the same `202` for real and unknown addresses, with
  padded timing, so it does not reveal which accounts exist.
- **Access links.** If someone cannot recover access, an examiner (for their candidates) or an admin can issue a
  one-time access link. It is shown once in the UI and is not emailed. An admin must pass a step-up check (a recent
  re-confirmation of credentials) first.

## Tests

```bash
# Rust: unit, integration and security tests (Postgres via Docker)
cd backend && bash scripts/cargo.sh test --workspace

# Web: typecheck, unit tests and production build
cd web && pnpm typecheck && pnpm test && pnpm build

# End to end against a seeded, running API
API_URL=http://localhost:8080 node tests/e2e/exam-flow.mjs
```

The end-to-end script signs in as the examiner and walks the full flow: authoring, publishing, enrolment, a candidate
attempt with saves, heartbeats and a journal sync, submission, grading, results and verification. It exits non-zero
if any check fails. Against the local API it passes 43 of 43 checks.

## Deployment

- **API:** `.github/workflows/api-image.yml` builds `backend/Dockerfile` and pushes `ghcr.io/inventixcity/invigil-api`
  tagged `latest` and the commit SHA. Render runs that image as described in `render.yaml` (liveness `/healthz`,
  migrations on boot, secrets set in the Render dashboard). After each image push, trigger a Render deploy (through the Render API or the dashboard); the image is not deployed automatically.
  `deploy/azure/` holds an alternative Azure path.
- **Web:** Vercel project `invigil`, built from `web/`. Environment: `API_ORIGIN` (the Render URL), `PROXY_SECRET`
  (identical to the API's), `NEXT_PUBLIC_API_ENABLED=true`, and `NEXT_PUBLIC_DEMO_LOGINS` (`true` only for judging).
- **Database:** Supabase Postgres (session pooler). The API runs migrations on boot.
- **Production secrets:** `DATABASE_URL`, `APP_ORIGIN`, `PROXY_SECRET`, `CODE_PEPPER`, `EXAM_LEASE_KEY` (32+ characters),
  `RESULT_SIGNING_KEY` (base64 of exactly 32 bytes), `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`.
  The API rejects production startup without the lease and signing keys.
- **Keep-alive:** `.github/workflows/keepalive.yml` pings the API health endpoint so the free tier stays responsive.

## Documentation

- [docs/DEMO.md](docs/DEMO.md): a 15-minute live demo script and answers to likely judge questions
- [docs/INNOVATION.md](docs/INNOVATION.md): the 5.3 and 5.1 design, threat table and residual risks
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, request pipeline, schema, crates and caching
- [docs/SECURITY.md](docs/SECURITY.md): STRIDE model, OWASP ASVS 5.0 mapping and data protection
- [docs/AUDIT-RESPONSE.md](docs/AUDIT-RESPONSE.md): response to the external review, with status and evidence
- [docs/RESEARCH.md](docs/RESEARCH.md): sources behind the design
