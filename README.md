# Inventix Invigil

**Exams that hold up.** Invigil is a secure online examination system. Admins provision accounts, examiners
author, run, monitor, grade and publish exams, and candidates take them in a timed workspace. That workspace keeps
working when the network drops, and nobody gains time from the outage.

- **Headline innovation, 5.3 Failure-Resilient Examinations:** server-signed time leases, a hash-chained offline
  journal in IndexedDB, verified outages and audited time credits.
- **Second innovation, 5.1 Integrity in the AI Era:** privacy-light indicators, invisible leak-tracing watermarks,
  an opt-in AI canary and a collusion indicator. We don't use the camera, the microphone or screen capture.
- **Stack:** Rust (axum, sqlx) API · Postgres · Next.js 16 web app with a same-origin proxy. No paid API is
  required.

Docs: [Architecture](docs/ARCHITECTURE.md) · [Innovation](docs/INNOVATION.md) · [Security](docs/SECURITY.md) ·
[Demo script](docs/DEMO.md) · [Research notes](docs/RESEARCH.md) · [Deployment](deploy/render/README.md)

## Test credentials

Every account uses the password **`Invigil#Demo2026`**. They're created by `api seed-demo`. The login page also has
one-click demo buttons for each role.

| Role | Email | What's waiting for them |
| --- | --- | --- |
| Admin | `admin@invigil.app` | User and role management, the audit log |
| Examiner | `examiner@invigil.app` (Dr. Ayesha Malik) | 30 bank questions and four exams: *Data Structures Midterm* (ongoing), *Web Security Quiz* (upcoming), *Databases Final* (completed, results published), *Algorithms Practice* (draft) |
| Examiner | `examiner2@invigil.app` | An empty account, for showing that one examiner can't see another's work (404) |
| Candidate | `candidate@invigil.app` (Ali Raza) | The ongoing midterm (not yet started, so you can take it live) and a published result with a certificate |
| Candidates | `candidate01@invigil.app` … `candidate24@invigil.app` | Enrolled in the demo exams. 20 of them have graded attempts on *Databases Final*, including one pair seeded with identical wrong answers |

## Requirements map

The examiner pages sit under `/app/examiner/exams/[examId]/…`, as the tabs Overview · Questions · Candidates ·
Review · Monitor · Grading · Results · Analytics. Crate names refer to `backend/crates/`.

### Core (3.1–3.8)

| Req | What it does | Web route | Crate |
| --- | --- | --- | --- |
| 3.1 Auth & authorization | Argon2id passwords, HttpOnly `__Host-session` cookie with only its SHA-256 stored, CSRF via `Sec-Fetch-Site`/`Origin`, provisioned accounts with invite links, and role extractors on every handler. A resource you may not see returns **404** | `/login`, `/invite/[token]`, `/admin/users` | `auth`, `kernel`, `admin`, `examcore` (`ExaminerViewer`, `CandidateViewer`, `AdminViewer`) |
| 3.2 Exam management | Lifecycle draft → published (scheduled) → ongoing → closed → completed, derived from the server clock. `If-Match` versioning, with per-state edit rules after publish, plus duplicate and unpublish (only while no attempts exist) | `/app/examiner/exams`, `/exams/new`, `/exams/[examId]` | `exam_authoring`, `examcore::phase` |
| 3.3 Question bank | Topics, difficulty 1–5, single / multi / written questions, negative marks and three multi-select rules. Publishing freezes the paper into an `exam_items` snapshot. Question and option order is shuffled per attempt with a seed, and each item keeps its own key, so every order marks the same | `/app/examiner/questions`, `/questions/new`, `/questions/[id]` | `exam_questions`, `exam_authoring`, `examcore::shuffle`, `examcore::score_objective` |
| 3.4 Enrollment & candidate view | Enroll by hand or by CSV, with a dry run first. Missing candidate accounts are created and one-time invite links shown. Accommodations add extra minutes. Candidates see Available / Upcoming / Completed | `/exams/[examId]/candidates`, `/app/candidate`, `/app/candidate/exams/[examId]` | `exam_enroll`, `exam_attempts` (`/me/exams`) |
| 3.5 Exam interface | Answered / unanswered / flagged palette and autosave. Resume keeps the server deadline, and the exam finalizes itself when the timer runs out (client submit plus a server sweep every 20 s) | `/exam/[attemptId]` | `exam_attempts`, `exam_resilience`, `web/src/lib/exam/*` |
| 3.6 Monitoring | Live roster (online, answered, flagged, incidents), announcements, a per-attempt indicator timeline, verified outages and time credits. Everything is labelled *indicators for review, not evidence* | `/exams/[examId]/monitor` | `exam_integrity`, `exam_resilience` |
| 3.7 Grading | Objective items are autograded, including the multi-select rules (all-or-nothing, partial, partial with penalty). Written answers are graded blind ("Script 07") against the rubric, with server-validated marks (0 ≤ marks ≤ max, in steps of 0.25) and feedback | `/exams/[examId]/grading` | `exam_grading` (`autograde_attempt`) |
| 3.8 Publication, analytics, retention | Publication is blocked until grading is complete and the window has closed. Publishing issues signed certificates, and unpublishing revokes them. Analytics cover the score distribution, KR-20 and topic means. Retention: attempts, grades, certificates and the audit log persist. Exams and questions are soft-deleted, and housekeeping purges expired sessions, codes and rate-limit windows | `/exams/[examId]/results`, `/exams/[examId]/analytics` | `exam_grading`, `exam_analytics`, `server::housekeeping` |

### Secondary (4.1–4.8)

| Req | What it does | Where (web) | Crate |
| --- | --- | --- | --- |
| 4.1 Network-aware UI | Good / unstable / offline banner from heartbeat RTT and failures, plus a save-state pill (Saved · Saving · Offline · Syncing N) | `components/workspace/network-banner.tsx`, `lib/exam/network.ts` | `exam_resilience` (heartbeat) |
| 4.2 PDF reports | A candidate result statement with a QR code, and an exam report with stats, distribution and item facility | `/api/reports/attempt/[attemptId]`, `/api/reports/exam/[examId]` | `exam_grading` (report JSON) |
| 4.3 Sandbox | "Preview as candidate" runs the real workspace on a separate sandbox snapshot. Sandbox runs never count in results, analytics or monitoring | Review tab → `/exam/[attemptId]` | `exam_authoring` (`/exams/{id}/sandbox`) |
| 4.4 Import | CSV or JSON question import, with row-level validation errors, a dry run, then an all-or-nothing commit (max 500 rows). Candidates import from CSV the same way | `/app/examiner/questions/import`, Candidates tab | `exam_questions`, `exam_enroll` |
| 4.5 Question analytics | Facility, discrimination (upper and lower 27%), skip rate, distractor picks and flags (too easy, too hard, negative discrimination, dead distractor). Observed difficulty is written back to the bank | Analytics tab | `exam_analytics` (`/questions/{id}/stats`) |
| 4.6 Verifiable reports | An Ed25519-signed, masked statement and a `XXXX-XXXX-XXXX` code. The QR code on the PDF opens the public verify page | `/verify`, `/verify/[code]` | `exam_grading`, `examcore::signer` |
| 4.7 Customizable workspace | Font scale, one question per screen or scroll, palette side, high contrast, theme, timer style and line spacing, saved per user | Workspace preferences drawer | `exam_attempts` (`/me/prefs`) |
| 4.8 Scratchpad | Rough-work text and a sketch canvas per attempt, kept on the server | Workspace scratchpad | `exam_attempts` (`/attempts/{id}/scratch`) |

## Innovation in one paragraph each

**5.3 Failure-resilient (headline).** The server sets the deadline when an attempt starts. Only an audited time credit
can move it, and an outage never pauses it. While the candidate is online, every heartbeat returns an HMAC-signed
*lease*: "attempt A was alive at server time T, deadline D". Offline answers are stamped with
`lease.issuedAt + monotonic elapsed time` and appended to a SHA-256 hash chain in IndexedDB, starting from a random
server genesis value. On reconnect the server checks every entry:
- the lease MAC is valid
- the stamped time is no later than the moment the server received it
- the stamped time is no later than the deadline
- the chain still links

The server also requires heartbeat gaps of 45 s or more before it treats an outage as verified. A time credit has to
match one of those outages. It's capped, given a reason, audited, and never granted automatically. A takeover from a
second device moves the device lock and records an incident. **Pull the plug: you lose nothing and gain nothing.**

**5.1 AI-era integrity.** Invigil records counts and durations, never content:
- focus and visibility changes
- fullscreen exits
- paste sizes
- typing composition (keystrokes compared with pasted characters)
- device changes

Each candidate's copy of every question carries an invisible zero-width watermark that encodes the attempt. If the
text leaks, the examiner pastes it into the leak tracer to find the source attempt. An opt-in, `aria-hidden` AI canary
flags answers produced by pasting the question into a chatbot. A Harpp–Hogan-style indicator (at least 3 identical
wrong answers, ratio ≥ 0.75) surfaces possible collusion. All of these feed a review priority that is shown as
*indicators for review, not evidence*. Details and threat tables are in [docs/INNOVATION.md](docs/INNOVATION.md).

## Architecture

```
 Browser (candidate / examiner / admin)
   │  IndexedDB journal + lease (5.3) · integrity signal collector (5.1) · server-offset clock
   │  same origin only: no CORS, first-party HttpOnly cookie
   ▼
 Next.js 16 on Vercel
   ├─ /api/v1/*        proxy route: server-to-server, forwards the cookie, signs the visitor IP with PROXY_SECRET
   ├─ /api/reports/*   PDF rendering (@react-pdf/renderer + QR), forwards the cookie to the API
   └─ pages            App Router, Ivory & Ink design system, /verify public
   ▼
 Rust API (axum 0.8) on Render
   pipeline: request id → timeout → CSRF (Sec-Fetch-Site + Origin) → rate limit (Postgres) → 1 MiB body cap
             → handler (role extractor + SQL ownership) → no-store, nosniff, CSP, frame deny, HSTS
   kernel · auth · admin · examcore
   exam_questions · exam_authoring · exam_enroll · exam_attempts · exam_resilience
   exam_grading · exam_integrity · exam_analytics
   housekeeping: attempt sweep every 20 s, retention every 10 min
   ▼
 Postgres 17 (Supabase in production: RLS enabled with no policies, anon/authenticated grants revoked)
```

## Tech stack and why

| Choice | Why |
| --- | --- |
| **Rust, axum 0.8, sqlx 0.8** | Correctness and memory safety where the money is (deadlines, grading, signatures). Low memory and fast cold paths on a small instance. sqlx keeps SQL explicit and parameterised, and `clippy::unwrap_used` is denied |
| **Postgres 17** | Transactions, `select … for update` row locks per attempt, partial unique indexes and check constraints as the last line of defence |
| **Next.js 16, React 19, TypeScript strict, Tailwind 4** | App Router server components for public pages, client components for the workspace. One codebase for the UI and the PDF and proxy routes |
| **Same-origin proxy** | The browser talks only to the web origin, so there's no CORS and the cookie stays first-party. The API trusts the client IP only when it's HMAC-signed by the proxy |
| **Supabase Postgres with an RLS lockdown** | Managed and free. RLS is enabled with no policies and grants are revoked, so the auto-generated REST API can't read anything. The API connects as the owner |
| **Render (API) + Vercel (web)** | Free tiers. The API runs as a container built from `backend/Dockerfile`, and the web app is a standard Next.js deploy |

## Local setup

Prerequisites: Docker, Node 24 with pnpm, and Git Bash on Windows. You don't need a local Rust toolchain:
`backend/scripts/cargo.sh` runs cargo in a container.

```bash
# 1. Database and a local mail inbox (http://localhost:8025)
docker compose up -d postgres mailpit

# 2a. API in a container on http://localhost:8080 (applies migrations on start)
docker compose up -d --build api
# 2b. …or build and check it with the containerised toolchain
bash backend/scripts/cargo.sh check -p server

# 3. Demo data (idempotent: skipped if admin@invigil.app already exists)
docker compose exec api /app/api seed-demo
#    or: cd backend && bash scripts/cargo.sh run -p server --bin api -- seed-demo

# 4. Web on http://localhost:3000
cd web
cat > .env.local <<'EOF'
API_ORIGIN=http://localhost:8080
NEXT_PUBLIC_API_ENABLED=true
EOF
pnpm install
pnpm dev
```

Sign in at <http://localhost:3000/login> with one of the demo buttons. Invite emails land in Mailpit, and the
examiner also sees each invite link once in the UI.

## Environment variables

Generate secrets with `openssl rand -hex 32`. The signing key needs exactly 32 random bytes, so use
`openssl rand -base64 32` for it.

| Variable | Service | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | API | yes | Supabase pooler URI in production |
| `APP_ENV` | API | prod | `production` turns on the startup secret checks and HSTS |
| `APP_ORIGIN` | API | yes | Public web URL, used in invite and verify links |
| `PROXY_SECRET` | API + web | prod | 32+ chars, identical on both sides. Signs the visitor IP |
| `TRUSTED_PROXY_HOPS` | API | prod | `1` behind the platform proxy |
| `CODE_PEPPER` | API | prod | 32+ chars, a pepper for one-time codes and tokens |
| `EXAM_LEASE_KEY` | API | prod | 32+ chars, the HMAC key for 5.3 time leases |
| `RESULT_SIGNING_KEY` | API | prod | base64 of 32 bytes, the Ed25519 seed for certificates |
| `MFA_ENCRYPTION_KEY` | API | prod | Encrypts TOTP secrets at rest |
| `RESEND_API_KEY` or `SMTP_URL`, plus `EMAIL_FROM` | API | prod | Invite emails (Resend free tier). Locally `SMTP_URL=smtp://mailpit:1025` |
| `RUN_MIGRATIONS` | API | no | `true` applies migrations at startup (the default outside production) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | API | no | Optional. No feature depends on them |
| `API_ORIGIN` | web | yes | Where the proxy forwards `/api/v1/*` |
| `NEXT_PUBLIC_API_ENABLED` | web | yes | `true` to call the real API |
| `SITE_URL` | web | no | Absolute base for Open Graph URLs. Defaults to the Vercel production URL |

Production refuses to start without valid `EXAM_LEASE_KEY`, `RESULT_SIGNING_KEY` and `PROXY_SECRET`.

## Tests

```bash
# Rust: unit tests and #[sqlx::test] integration tests (needs the compose postgres)
cd backend && bash scripts/cargo.sh test -p examcore -p exam_questions -p exam_authoring -p exam_enroll \
  -p exam_attempts -p exam_resilience -p exam_grading -p exam_integrity -p exam_analytics -p server

# Web: types and unit tests (including the journal hash-chain vector shared with Rust)
cd web && pnpm typecheck && pnpm test

# End to end against a running API with demo data:
# author → publish → enroll → invite → take → submit → grade → publish → verify
API_URL=http://localhost:8080 node tests/e2e/exam-flow.mjs

# Security probes (authorization, key leaks, timing, validation). See docs/SECURITY.md
API_URL=http://localhost:8080 node tests/security/probes.mjs
```

## Deployment

Render runs the API container and Vercel runs the web app, with Supabase as the database. The step-by-step guide is
in [deploy/render/README.md](deploy/render/README.md): environment, first migration, `api seed-demo` and the Vercel
env vars (`API_ORIGIN`, `PROXY_SECRET`, `NEXT_PUBLIC_API_ENABLED`).

## Repository layout

```
backend/              Rust workspace: crates/*, migrations/, Dockerfile, scripts/cargo.sh
web/                  Next.js 16 app: src/app (routes), src/components, src/lib/exam (5.3 engine, 5.1 collector)
docs/                 ARCHITECTURE, INNOVATION, SECURITY, DEMO, RESEARCH
tests/e2e/            exam-flow.mjs
tests/security/       probes.mjs
deploy/               deployment scripts and guide
```

© Inventix. Invigil was built in one day for the hackathon.
