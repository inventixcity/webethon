# Invigil: master handoff (read this first, every agent)

**Inventix Invigil** ("Exams that hold up.") is a secure examination management system: admins manage users and
roles, examiners author, run, monitor, grade and publish exams, and candidates take them. Built in 8 hours
(27 Nov 2026). This file is the single source of truth and the handoff if any agent or lead runs out of usage.

- **Lead:** Claude (Opus). Reviews every pass, fixes breakage, commits and pushes to `main`.
- **Workers:** Codex `gpt-6-luna` (medium) on C1–C9, Codex `gpt-6.1-terra` (high) as reviewer R1, Claude Haiku on H1–H5.
- **Rule:** workers NEVER run `git commit`, `git push`, `git reset`, `git checkout --` or `git stash`. Only the lead does git.
- **Rule:** never mention any other project, kit or template in code, comments, commits or docs. This is Invigil.
- **Rule:** stay inside the files you own (table below). Need a change elsewhere? Write it under *Requests to lead* in your log entry.

## 1. Decisions (fixed; do not re-litigate)

| Topic | Decision |
| --- | --- |
| Backend | Rust (axum 0.8, sqlx 0.8, Postgres 17) in `backend/`. One crate per worker: `crates/exam_*`. Shared code in `crates/examcore`. |
| Web | Next.js 16 App Router, React 19, TS strict, Tailwind 4 in `web/`. Browser → same-origin `/api/v1/*` proxy → Rust API. No CORS. |
| Next server extras | PDF reports (`web/src/app/api/reports/**`), CSV parsing for import previews (client side), public verify page. Security decisions always in Rust. |
| DB | Supabase Postgres in prod (RLS enabled with no policies + grants revoked, so PostgREST is blocked; API connects as owner). Local: docker compose `postgres` (db `invigil`, port 55432). |
| Deploy | Web on Vercel. API container on Azure Container Apps (min replicas 1). |
| Accounts | Provisioned: admin creates examiners; examiners create/import candidates. Email invite with set-password link (Resend). Login page has demo-credential buttons per role. |
| Roles | DB `users.role` in `user|examiner|admin`; `user` is presented as `candidate`. `kernel::Viewer` has `can_examine()`, `require_examiner()`, `require_candidate()`. Use `examcore::{ExaminerViewer, CandidateViewer, AdminViewer}` extractors. |
| Innovation | **5.3 Failure-resilient** (headline) and **5.1 AI-era integrity**. |
| Timing | Server clock only. `attempts.deadline_at` = min(started_at + duration + extra_minutes, ends_at) + audited time credits. Never paused automatically. |
| UI | Ivory & Ink design (`web/docs/DESIGN.md`): square corners, paper/ink tokens, one vermilion accent, Bricolage Grotesque + JetBrains Mono, light+dark, reduced motion. Error pages: the existing ASCII/Shark error pages (`components/errors/*`, `app/error/[code]`). |
| AI grading | Optional Gemini suggestion for written answers (free tier, OpenAI-compatible endpoint via the `ai` crate) only if `AI_API_KEY` is set. Rubric grading always works without it. Not required for any feature. |

## 2. Architecture

```
Browser ── HTTPS ──▶ Vercel (Next.js 16)
   │  IndexedDB journal (5.3), integrity signal collector (5.1)
   ▼
 /api/v1/* proxy (server-to-server, HMAC-signed client IP)        /api/reports/* (PDF, forwards cookie)
   ▼
 Rust `api` binary (axum) on Azure Container Apps
   kernel: config, errors, sessions (HttpOnly __Host-session, SHA-256 at rest), CSRF (Sec-Fetch-Site + Origin),
           Postgres-backed rate limits, audit log, security headers
   auth / admin: sign-in, Argon2id, sessions, MFA, user management
   examcore: role extractors, access checks, scoring, shuffle, leases, journal chain, Ed25519 signer
   exam_questions | exam_authoring | exam_enroll | exam_attempts | exam_resilience | exam_grading
   | exam_integrity | exam_analytics
   ▼
 Postgres (Supabase)  migrations/20261127000001_exams_core.sql = the exam schema
```

### Request pipeline (already in `crates/server`)
request id + timeout → CSRF → rate limit (600 reads / 120 writes per minute per IP) → body limit (1 MiB) → JSON
nesting check → handler → security headers (`no-store`, nosniff, CSP, frame deny, HSTS in prod).

## 3. Ownership map

| ID | Agent | Owns (create/edit only these) |
| --- | --- | --- |
| LEAD | Claude | `backend/crates/examcore/**`, `backend/crates/kernel/**`, `backend/migrations/20261127000001_exams_core.sql`, `backend/Cargo.toml`, `web/src/lib/exam/types.ts`, `handoff/HANDOFF.md` sections 1–7 |
| C1 | codex luna | `backend/crates/exam_questions/**`, migrations `20261127001100_*` |
| C2 | codex luna | `backend/crates/exam_authoring/**`, migrations `20261127001200_*` |
| C3 | codex luna | `backend/crates/exam_enroll/**`, migrations `20261127001300_*`, `web/src/app/(auth)/invite/**` |
| C4 | codex luna | `backend/crates/exam_attempts/**`, migrations `20261127001400_*` |
| C5 | codex luna | `backend/crates/exam_resilience/**`, migrations `20261127001500_*`, `web/src/lib/exam/{journal,sync,use-attempt,network,device,clock}.ts(x)` |
| C6 | codex luna | `backend/crates/exam_grading/**`, migrations `20261127001600_*`, `web/src/app/api/reports/**`, `web/src/app/verify/**`, `web/src/lib/exam/pdf/**` |
| C7 | codex luna | `backend/crates/exam_integrity/**`, migrations `20261127001700_*`, `web/src/lib/exam/integrity.ts` |
| C8 | codex luna | `backend/crates/exam_analytics/**`, migrations `20261127001800_*`, `backend/crates/admin/src/users.rs` (role values), `backend/crates/server/src/main.rs` seed subcommand only |
| C9 | codex luna | `backend/crates/server/src/{lib.rs,housekeeping.rs}`, `backend/Dockerfile`, `deploy/**`, `.github/**`, `docker-compose.yml`, `web/next.config.ts`, `web/src/proxy.ts`, `README.md`, `docs/**`, `tests/e2e/**` |
| R1 | codex terra (high) | Read-only review. Writes only `handoff/reviews/*.md`. |
| H1 | haiku | `web/src/app/page.tsx` (landing), `web/src/app/(auth)/login/**`, `web/src/components/app-shell/**`, `web/src/app/(app)/app/page.tsx` (role redirect), `web/src/app/(app)/app/candidate/**` (dashboard, lobby, results), `web/src/components/candidate/**` |
| H2 | haiku | `web/src/app/(exam)/**` (workspace route + layout), `web/src/components/workspace/**` |
| H3 | haiku | `web/src/app/(app)/app/examiner/questions/**`, `web/src/components/questions/**`, `web/src/components/import/**` |
| H4 | haiku | `web/src/app/(app)/app/examiner/page.tsx`, `web/src/app/(app)/app/examiner/exams/page.tsx`, `.../exams/new/**`, `.../exams/[examId]/(setup)/**` (overview, questions, candidates, review), `web/src/components/exams/**` |
| H5 | haiku | `web/src/app/(app)/app/examiner/exams/[examId]/{monitor,grading,results,analytics}/**`, `web/src/components/monitor/**`, `web/src/components/grading/**`, `web/src/components/analytics/**`, `web/src/app/(admin)/admin/users/**` |

Shared read-only for all: `web/src/lib/api/client.ts` (`api<T>(path, {method, body, headers})` returns `data`, throws `ApiError{code,status,details}`), `web/src/components/ui/*` (Button, Input, Checkbox, Label), `web/src/components/charts`, `web/src/components/loaders`, `web/src/components/feedback/toaster.tsx`, `web/src/components/errors/*`, `web/src/lib/exam/types.ts`.

## 4. API contract (all under `/api/v1`, JSON, `{data}` envelope; types in `web/src/lib/exam/types.ts`)

Errors use the kernel envelope `{error:{code,message,details,requestId}}`. Not authorized to see = **404** (never
leak existence). Authorized to see but not act = 403. Validation = 422 `VALIDATION_FAILED` with
`details:[{path,message}]`. State conflicts = 409 with `details.reason`.

| Method & path | Who | Owner | Returns |
| --- | --- | --- | --- |
| GET `/questions?topic&difficulty&kind&q&cursor&limit` | examiner (own; admin all) | C1 | `Page<Question>` |
| POST `/questions` · GET/PATCH/DELETE `/questions/{id}` | examiner owner | C1 | `Question` (PATCH needs `If-Match: <version>`; DELETE soft) |
| GET `/questions/topics` | examiner | C1 | `{topic,count}[]` |
| POST `/questions/import` `{rows, dryRun}` | examiner | C1 | `ImportResult` (all-or-nothing when not dryRun; max 500 rows) |
| GET `/exams?status&cursor` · POST `/exams` | examiner | C2 | `Page<ExamSummary>` · `Exam` |
| GET/PATCH/DELETE `/exams/{id}` | examiner owner | C2 | `Exam` (PATCH draft only except `instructions`/`endsAt` extension rules; `If-Match`) |
| PUT `/exams/{id}/questions` `{items:[{questionId,marks?}]}` | owner, draft | C2 | `Exam` |
| GET `/exams/{id}/review` | owner | C2 | `ExamReview` |
| POST `/exams/{id}/publish` · `/unpublish` (no attempts) · `/complete` · `/duplicate` | owner | C2 | `Exam` |
| POST `/exams/{id}/sandbox` | owner (any status) | C2 | `{attemptId}`; sandbox attempt on a sandbox snapshot, `attempts.sandbox=true` |
| GET/POST `/exams/{id}/enrollments` `{candidates: CandidateImportRow[], invite, dryRun}` | owner | C3 | `Enrollment[]` / `ImportResult` (creates missing candidate accounts) |
| PATCH/DELETE `/exams/{id}/enrollments/{candidateId}` `{extraMinutes}` | owner | C3 | `Enrollment` |
| POST `/exams/{id}/enrollments/{candidateId}/invite` | owner | C3 | `{sent:true}` (rate limited) |
| GET `/auth/invites/{token}` · POST `/auth/invites/accept` `{token,password,displayName}` | public | C3 | `{email,displayName}` / signs in (sets session cookie) |
| GET `/me/exams` | candidate | C4 | `CandidateDashboard` |
| GET `/me/exams/{examId}` | enrolled candidate | C4 | `ExamLobby` |
| POST `/me/exams/{examId}/attempt` | enrolled candidate, in window | C4 | `{attemptId}` (start or resume; idempotent via unique index) |
| GET `/attempts/{id}` (header `X-Attempt-Device`) | attempt owner (candidate, or examiner for sandbox) | C4 | `AttemptPayload` (no keys) |
| PUT `/attempts/{id}/answers/{itemId}` | owner + active device + before deadline | C4 | `SaveAnswerResult` (ignored if `clientSeq` ≤ stored) |
| POST `/attempts/{id}/submit` `{confirm:true}` | owner | C4 | `{status, submittedAt}` (idempotent; second call returns same) |
| GET/PUT `/attempts/{id}/scratch` | owner | C4 | `Scratch` |
| GET/PUT `/me/prefs` | any signed-in | C4 | `WorkspacePrefs` |
| POST `/attempts/{id}/heartbeat` | owner | C5 | `HeartbeatResult` (records connectivity, issues fresh lease, new announcements) |
| POST `/attempts/{id}/journal` `{entries: JournalEntry[]}` | owner | C5 | `JournalSyncResult` |
| POST `/attempts/{id}/takeover` | owner (new device) | C5 | `{deviceActive:true}` + incident `device_takeover` |
| GET `/attempts/{id}/outages` | exam owner | C5 | `Outage[]` |
| POST `/attempts/{id}/time-credit` `{seconds,reason,outageFrom?,outageTo?}` | exam owner | C5 | `{deadlineAt}` (≤ verified outage length unless admin; audited) |
| POST `/attempts/{id}/events` `{events: IntegrityEventInput[]}` | owner | C7 | `{recorded}` (≤50/batch, rate limited) |
| GET `/exams/{id}/monitor` | owner | C7 | `ExamMonitor` |
| GET `/attempts/{id}/integrity` | exam owner | C7 | `IntegrityReport` |
| GET/POST `/exams/{id}/announcements` `{body}` | owner (POST), owner/enrolled (GET) | C7 | `Announcement[]` / `Announcement` |
| POST `/exams/{id}/trace` `{text}` | owner | C7 | `{attemptId, candidate}|null` (decode leaked-text watermark) |
| GET `/exams/{id}/grading?pending=true` | owner | C6 | `GradingItem[]` |
| PUT `/attempts/{id}/answers/{itemId}/grade` `{marks,feedback}` | exam owner | C6 | `GradingItem` (0 ≤ marks ≤ item marks, 0.25 steps) |
| GET `/exams/{id}/results` | owner | C6 | `ExamResults` |
| POST `/exams/{id}/results/publish` · `/results/unpublish` | owner | C6 | `ExamResults` (issues/revokes certificates) |
| GET `/me/results/{attemptId}` | candidate, own, published | C6 | `CandidateResult` |
| GET `/attempts/{id}/report` · GET `/exams/{id}/report` | candidate own published / exam owner | C6 | JSON data for PDFs |
| GET `/verify/{code}` | public, rate limited | C6 | `VerificationResult` |
| GET `/exams/{id}/analytics` | owner | C8 | `ExamAnalytics` |
| GET `/questions/{id}/stats` | owner | C8 | item history across exams |
| admin: existing `/admin/users*` with role `user|examiner|admin` | admin | C8 | |

Library functions crossing crates (keep signatures stable):
- `exam_grading::autograde_attempt(tx: &mut PgConnection, attempt_id: Uuid) -> AppResult<()>`: scores objective answers with `examcore::score_objective`, sets `auto_score/total_score/grading_status`.
- `exam_attempts::finalize(tx, attempt_id, by: &str) -> AppResult<()>`: idempotent; sets status, calls autograde.
- `exam_attempts::sweep(db: &PgPool) -> AppResult<u64>`: finalizes attempts past `deadline_at + JOURNAL_GRACE` (C9 calls it from housekeeping every 20 s).
- `exam_attempts::store::upsert_answer(tx, attempt_id, item_id, response, flagged, seq, source, written_at, typing)`: the only answer writer (C5 journal uses it).

## 5. Security rules (non-negotiable)

1. Every handler takes a role extractor and checks ownership in SQL (`where owner_id = $viewer` or via `examcore::load_exam_*`). UI hiding is never protection.
2. Answer keys (`correct`, `rubric`, `explanation`) never appear in candidate responses until results are published and `showBreakdown` is on.
3. Validate everything server-side: lengths, enums, numeric ranges, UUIDs; `#[serde(deny_unknown_fields)]` on every input struct.
4. Writes in transactions; use `select ... for update` on the attempt row for save/submit/journal/takeover to serialise per attempt.
5. Idempotency: answer saves keyed by `client_seq`; submit/publish are idempotent; start uses the unique index (`on conflict do nothing` then select).
6. Server time only (`now()` in SQL or `examcore::now()`). Client times are informational.
7. Audit every examiner/admin state change with `kernel::security::audit` (no bodies, no secrets).
8. Rate limit public and high-frequency endpoints with `kernel::security::enforce_rate_limit` (see `limits`).
9. Monitoring indicators are never verdicts: always label them "indicators for review, not evidence".
10. No secrets in code or logs. New env vars go in `.env.example` (ask C9) and section 7.

## 6. Conventions

- Rust crates follow `backend/crates/flags/src/lib.rs` (router, extractors, `invalid()` errors, tests with `#[sqlx::test(migrations = "../../migrations")]`).
- Build/test without a local toolchain: `cd backend && bash scripts/cargo.sh check -p <crate>` / `bash scripts/cargo.sh test -p <crate>` (Docker; Postgres from `docker compose up -d postgres`). `clippy::unwrap_used` is denied.
- Marks: SQL `::float8`, Rust `f64`, `examcore::round2`.
- Web: `pnpm --dir web typecheck` must pass for your files. Use `api()` from `@/lib/api/client`, `Button` from `@/components/ui/button`, tokens only (no raw hex), square corners, `font-mono` uppercase 11px labels, `aria-*` on every control, responsive from 360 px, both themes.
- Every page has loading, empty and error states (use `components/errors/segment-error.tsx` for route errors, `components/loaders` for loading).

## 7. Environment

| Var | Where | Notes |
| --- | --- | --- |
| `DATABASE_URL` | API | Supabase pooler URI in prod |
| `APP_ORIGIN` | API | Vercel prod URL |
| `PROXY_SECRET` | API + Vercel | 32+ chars, identical |
| `CODE_PEPPER` | API | 32+ chars |
| `EXAM_LEASE_KEY` | API | 32+ chars (5.3 lease HMAC) |
| `RESULT_SIGNING_KEY` | API | base64 of 32 random bytes (Ed25519 seed, 4.6) |
| `RESEND_API_KEY`, `EMAIL_FROM` | API | invites |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | API | optional Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`) |
| `API_ORIGIN`, `NEXT_PUBLIC_API_ENABLED=true` | Vercel | proxy target |

## 8. Status board (lead updates after each pass)

| Pass | Time (PKT) | State |
| --- | --- | --- |
| 0 | 10:40 | Repo bootstrapped; schema, examcore, contract types and crate scaffolds compile. Workers launching. |

## 9. Worker log (APPEND ONLY, newest at bottom)

Workers append their entry to **`handoff/log/<ID>.md`** (their own file, so parallel writers never clobber each
other). The lead reviews each pass and appends the reviewed entry here. Format:

```
### <ID> · pass <n> · <HH:MM>
- Done: ...
- Verified: <commands run and result>
- Open / known gaps: ...
- Requests to lead: ...
```
