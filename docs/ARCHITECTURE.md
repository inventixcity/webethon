# Invigil architecture

This document covers the components, the request path, the database design, what each crate is responsible for,
caching, and the decisions we made with their trade-offs. The security controls are in [SECURITY.md](SECURITY.md),
and the 5.3 and 5.1 mechanisms are in [INNOVATION.md](INNOVATION.md).

## 1. Components

```
┌──────────────────────────── Browser ────────────────────────────┐
│ Next.js pages (React 19)                                        │
│ web/src/lib/exam/                                               │
│   clock.ts      server-offset clock (never Date.now for time)   │
│   device.ts     stable device id → X-Attempt-Device header      │
│   journal.ts    IndexedDB hash-chained answer journal + lease   │
│   sync.ts       save queue: online PUT, offline journal, retry  │
│   network.ts    good / unstable / offline from heartbeats       │
│   use-attempt   one hook the workspace consumes                 │
│   integrity.ts  focus, fullscreen, paste-size, typing counters  │
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTPS, same origin, HttpOnly __Host-session cookie
┌───────────────▼──────────── Vercel (Next.js 16) ────────────────┐
│ /api/v1/[...path]   proxy: allow-listed headers, 1 MiB body,    │
│                     15 s timeout, HMAC-signed visitor IP        │
│ /api/reports/*      PDF (react-pdf + qrcode), forwards cookie   │
│ /verify, /verify/[code]   public certificate check              │
│ proxy.ts            route gating (/app, /exam need a session)   │
└───────────────┬─────────────────────────────────────────────────┘
                │ server to server (API_ORIGIN)
┌───────────────▼──────────── Rust API (Render) ──────────────────┐
│ server     router assembly, middleware, housekeeping loops      │
│ kernel     config, errors, sessions, CSRF, rate limits, audit   │
│ auth/admin sign-in, Argon2id, MFA, user and role management     │
│ examcore   extractors, access checks, scoring, shuffle, leases, │
│            journal chain, Ed25519 signer                        │
│ exam_*     eight feature crates (section 4)                     │
└───────────────┬─────────────────────────────────────────────────┘
                │ sqlx pool (statement_timeout 10 s)
┌───────────────▼──────────── Postgres 17 (Supabase) ─────────────┐
│ RLS on every table with no policies, anon/authenticated revoked │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Request pipeline

Each API request goes through these layers in order. They're assembled in `backend/crates/server/src/lib.rs`.

1. **Request id and observability.** The id is accepted or minted, echoed as `x-request-id` and attached to every
   log line. Per-route counters and latency histograms are recorded.
2. **Timeout.** The default is 15 s, so a slow request returns a 503 with `Retry-After` instead of hanging.
3. **CSRF.** A state-changing method that carries a session cookie must pass the `Sec-Fetch-Site` / `Origin` check.
4. **Rate limit.** A Postgres-backed fixed window per subject (the trusted client IP): 600 reads or 120 writes per minute. The IP
   is trusted only when the proxy has signed it with `PROXY_SECRET`. The feature crates add per-user and per-attempt
   budgets on top, for example 20 heartbeats per minute per attempt, 5 takeovers per hour, 30 verifies per minute
   per IP and 20 imports per hour.
5. **Body limit and JSON checks.** The body is capped at 1 MiB and deep nesting is rejected. Every input struct is
   `#[serde(deny_unknown_fields)]`.
6. **Handler.** A role extractor (`ExaminerViewer`, `CandidateViewer`, `AdminViewer`) runs first. Ownership is then
   checked in SQL, through `examcore::load_exam_for_examiner` or `where owner_id = $viewer`, and a miss is a
   **404**. State changes run in one transaction, with `select … for update` on the attempt row.
7. **Response headers.** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
   `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Resource-Policy: same-origin`, and HSTS in production.

Success responses always look like `{"data": …}`. Errors look like `{"error": {code, message, details, requestId}}`.
Validation errors are 422 with `details: [{path, message}]`, and state conflicts are 409 with `details.reason`
(`closed`, `device`, `credit_cap`, `published`, and so on).

**Background loops** in `server/src/main.rs` and `housekeeping.rs`:
- Every 20 s, `exam_attempts::sweep` finalizes attempts past `deadline_at + 120 s` as `expired`. It works in batches
  of 200 with `for update skip locked`, so it's safe to run on several replicas.
- Every 10 min, retention deletes expired sessions, codes, rate-limit windows and old request statistics, at most
  1000 rows per statement.

## 3. Database design

The exam schema is one migration: `backend/migrations/20261127000001_exams_core.sql`. The API enforces every
invariant first. Constraints and indexes are the last line of defence.

| Table | Purpose | Why it's shaped this way |
| --- | --- | --- |
| `users.role` (constraint) | `user` / `examiner` / `admin`. `user` is presented as *candidate* | Keeps the existing auth code working while adding the two exam roles |
| `workspace_prefs` | Per-user workspace settings (4.7) | A small JSON document (≤ 4 KB), validated against enums by the API |
| `account_invites` | One-time set-password links for provisioned accounts | Only the **SHA-256 of the token** is stored. 7-day expiry, single use (`update … where used_at is null and expires_at > now()`) |
| `questions` | The bank: topic, difficulty, kind, stem, options, `correct`, marks, negative marks, multi rule, rubric, max words, explanation, observed facility | A check constraint ties the kind to its options and key (single = exactly 1 correct, multi ≥ 1, written = none). `version` backs `If-Match`. Soft-deleted with `deleted_at`. `observed_facility` is refreshed by analytics |
| `exams` | Title, window (`starts_at`, `ends_at`), duration, total and pass marks, `settings` JSON, lifecycle timestamps | Only `draft / published / completed / archived` is stored. **`ongoing` is derived** from the server clock (`examcore::phase`), so it can never be stale. Checks enforce `ends_at > starts_at`, `pass ≤ total`, and that results can only be published for a published exam |
| `exam_questions` | The draft assignment: which bank questions, in what order, with optional per-exam marks | Editable while the exam is a draft. A unique `(exam_id, position)` index keeps the order unambiguous |
| `exam_items` | **The frozen paper.** A full copy of each question (stem, options, key, marks, rule, rubric) written at publish time | Editing or deleting a bank question never changes a live or finished paper, and every grade is reproducible. `sandbox = true` rows are a separate snapshot for the examiner preview (4.3), so the real paper is never touched |
| `enrollments` | Candidate × exam, `enrolled` or `revoked`, `extra_minutes` (0–600) | Accommodations live here and are audited. Revoking blocks a start, even mid-window |
| `attempts` | One sitting: status, **`deadline_at`**, seed, `item_order`, `option_order`, `active_device`, the journal head and genesis, scores, `grading_status`, `review_priority` | `deadline_at` is computed **once, by the server**, at start: `least(now + duration + extra, ends_at)`. Only a `time_credits` row moves it. The seed and the stored orders make the shuffle reproducible on any device. **`attempts_one_real_idx`** is a partial unique index on `(exam_id, candidate_id) where not sandbox`, so two concurrent "start" requests produce one attempt (`on conflict do nothing`, then select), while sandbox runs don't collide. `attempts_deadline_idx` (partial, `in_progress`) keeps the sweep cheap |
| `answers` | One row per attempt × item: response JSON, flag, `client_seq`, `source` (online or journal), `saved_at`, `written_at`, typing counts, auto and manual marks, feedback | **`client_seq` makes saves idempotent and ordered**: the upsert only applies when the incoming seq is higher. Journal entries use `seq + 1 000 000 000`, so a replayed offline answer always beats an older online save. `typing` holds counts only (≤ 2 KB) |
| `attempt_scratch` | Rough work (4.8): text and a PNG sketch | One document per attempt, capped at 512 KB |
| `time_credits` | Extra seconds for a verified outage: seconds (1–3600), reason, the outage window, `granted_by` | Never automatic. Each row is an audited decision by a person, and non-admin credits are capped at the uncredited verified outage time (admins bypass the outage check) |
| `attempt_heartbeats` | Server-receipt timestamps of heartbeats, online flag, pending count | Outages are computed from **gaps between heartbeats the server actually received**, so a client can't claim one |
| `attempt_events` | The integrity and lifecycle timeline: kind (an enumerated list), severity, flat detail, duration, client time | The kinds are a closed list. `client_at` is informational, while `recorded_at` is the server's. Detail is capped at 2 KB and never holds content |
| `announcements` | Examiner broadcasts to an exam | Delivered on the next heartbeat (≤ 15 s) and shown as a toast |
| `result_certificates` | One per attempt at publication: `verify_code`, masked `statement`, `statement_hash`, Ed25519 `signature`, `key_id`, `revoked_at` | The verify page recomputes the SHA-256 of the canonical statement and checks the signature, so a row edited in the database fails verification. Unpublishing sets `revoked_at` rather than deleting. The statement holds only masked facts (initials, exam, percent, pass, issue date) |
| RLS block | Enables row-level security on every public table with no policies, and revokes grants from `anon` and `authenticated` | Supabase's auto-generated REST API can't read or write anything. The API connects as the table owner, so it isn't affected |

## 4. Crates

| Crate | Responsibility |
| --- | --- |
| `server` | Binary `api` with the subcommands `serve`, `migrate`, `seed-demo` and `healthcheck`. Mounts the auth and admin routers, the eight exam routers and health endpoints. Upload, AI and other product routers are not mounted. Middleware stack, housekeeping loops, and production startup checks (`EXAM_LEASE_KEY`, `RESULT_SIGNING_KEY`) |
| `kernel` | Config, the error envelope, sessions (a random 256-bit token stored as its SHA-256), the CSRF origin check, Postgres rate limits, audit writer, crypto helpers, email senders |
| `auth`, `admin` | Sign-in, Argon2id, MFA, session lifecycle. Admin user management, with role values `user / examiner / admin` and invites for provisioned accounts |
| `examcore` | Shared building blocks: role extractors, `load_exam_for_examiner` and `load_exam_for_candidate` (404 on a miss), `phase`, **`score_objective`** (the one marking function), deterministic `shuffle` (SplitMix64 plus Fisher–Yates), time **leases** (HMAC-SHA-256), **`chain_next`** (the journal hash), `canonical_json`, and the Ed25519 `signer` |
| `exam_questions` | Bank CRUD with `If-Match`, filters, keyset pagination, topics, and import (500 rows, row-level errors, dry run, all or nothing). 30 bundled seed questions |
| `exam_authoring` | Exam CRUD, per-state edit rules, assignment, the review checklist, **publish (snapshot into `exam_items` under a row lock, idempotent)**, unpublish, complete, duplicate, sandbox |
| `exam_enroll` | Enrollment import (up to 1000 rows, all or nothing), candidate provisioning, invite tokens and email (sent after commit, a failure is never fatal), the invite accept flow that creates a session, accommodations, revocation |
| `exam_attempts` | Candidate dashboard and lobby, start or resume (unique index), the workspace payload with **no keys**, autosave with the deadline and device checks under a lock, idempotent submit, `finalize`, `sweep`, scratchpad, prefs, `watermark`, `canary_word` |
| `exam_resilience` | Heartbeat (lease, verified gaps, announcements), **journal sync verification**, device takeover, verified outages, capped and audited time credits |
| `exam_grading` | `autograde_attempt`, blind written grading, results and publication rules, certificates, the candidate result (keys only when results are published and the breakdown is on), report JSON for PDFs, public verify |
| `exam_integrity` | Event ingestion (allow-listed kinds, flat detail, ≤ 50 per batch), the review-priority score, the integrity report with plain-language indicators, the live monitor query, announcements, the leak tracer |
| `exam_analytics` | Score statistics, KR-20, item facility and discrimination, distractors, flags, topic means, the collusion indicator, and the observed difficulty written back to the bank |

## 5. Caching

| Layer | What's cached | Why it's safe |
| --- | --- | --- |
| **Paper snapshot cache** (`exam_attempts`) | The per-exam item list in memory, in a `RwLock<HashMap>` keyed by `(exam_id, sandbox, exam.version)`, holding at most 128 papers (cleared when full) | Hundreds of candidates load the same paper when an exam opens. Published items are immutable, and any change bumps `version`, which changes the key. A sandbox entry is used only if it holds every item in the attempt's order, so a fresh sandbox run reloads. Each candidate's view (order, options, watermark, answers) is still built per request |
| **Static assets** (Next) | `/_next/static/*` is served with `public, max-age=31536000, immutable` | The file names are content-hashed |
| **API and pages** | Nothing. The API sets `Cache-Control: no-store` on every response, and the web app sets `no-store` on pages | Exam state, answers and results are personal and change every second. A shared cache must never hold them |
| **Browser** | The IndexedDB journal, the latest lease, `clientSeq`, the device id | This is durability rather than caching: it lets the browser recover un-synced answers after a refresh or an outage |

## 6. Key design decisions

| Decision | Trade-off we accepted |
| --- | --- |
| **The server clock is the only clock.** `deadline_at` is fixed at start, the client counts down from a server offset, and every save is checked against `now()` in SQL | A candidate with a badly skewed clock still sees the right countdown. The cost is one heartbeat round trip to learn the offset |
| **The deadline never pauses for an outage.** Recovery is an audited time credit tied to a verified outage | It's fairer and impossible to game automatically, but it needs an examiner decision, and a candidate who was offline must wait for a person |
| **Snapshot at publish** (`exam_items`) instead of referencing the bank | It duplicates data, but grades are reproducible forever and editing the bank is always safe |
| **404 for anything you can't see** | Debugging is slightly harder, but no endpoint confirms that an exam, attempt or question exists |
| **One active device per attempt**, with an explicit takeover | A broken laptop can be swapped for another in seconds, and a hidden second device becomes a recorded incident. The old device stops at once |
| **Hash-chained offline journal** plus signed leases, instead of trusting client timestamps | More code on both sides, and an unkeyed chain protects ordering and integrity rather than authenticity (see INNOVATION). It never extends time |
| **A Rust API behind a same-origin proxy** | One extra hop (Vercel → Render) on every API call. In return there's no CORS and a first-party cookie, and security never depends on the Next layer, because every decision is made in Rust |
| **Postgres for rate limits** instead of Redis | One less service and correct across replicas. It costs a write per request, which is acceptable at exam scale |
| **The paper cache is in-process** | Each replica warms its own copy, and a miss is a single indexed query |
| **Indicators, never verdicts** | We give up "automatic cheating detection" in exchange for fairness and fewer false accusations. The examiner always decides |
| **No webcam, microphone or screen capture** | Weaker deterrence against a determined cheater. In return the system is privacy-respecting, accessible, cheap and works on poor connections |
