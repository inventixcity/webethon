# Invigil security model

This document covers the threats to the exam workflow, the controls that answer them (mapped to OWASP ASVS 5.0),
how personal data is handled, the indicator privacy stance, and the residual risks we accept. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md). The 5.3 and 5.1 mechanisms are in [INNOVATION.md](INNOVATION.md). The response to
the external review is in [AUDIT-RESPONSE.md](AUDIT-RESPONSE.md).

**Principle.** The Rust API makes every security decision. The browser and the Next.js layer are presentation and
transport. Hiding a control in the UI is never a control.

## 1. Trust boundaries

```
Candidate or examiner browser ──HTTPS──▶ Vercel (Next.js: pages, same-origin /api/v1 proxy)
      (untrusted: may be offline, modified, or shared)            │ server-to-server, client IP signed with PROXY_SECRET
                                                                  ▼
                                                    Rust API on Render (authorization, timing, scoring, signing)
                                                                  │ sqlx, owner role only
                                                                  ▼
                                                    Supabase Postgres (RLS on, anon/authenticated grants revoked)
```

Three boundaries matter most: browser to proxy (untrusted input), proxy to API (authenticated by `PROXY_SECRET`), and
API to database (parameterized queries under the API's owner role).

## 2. STRIDE threat model for the exam workflow

| Category | Threat in the exam workflow | Controls | Where | Residual |
| --- | --- | --- | --- | --- |
| **Spoofing** | Someone signs in as a candidate and sits the exam for them | Argon2id passwords; server sessions; one active device per attempt, with an explicit rate-limited takeover that records an incident; MFA routes for staff | `auth/src/password.rs`, `auth/src/routes.rs`, `auth/src/mfa.rs`, `totp.rs`, `exam_resilience::takeover` | Credential sharing on one device is not detectable; the integrity indicators are the after-the-fact signal |
| **Spoofing** | Forged examiner or admin requests | Role extractors (`ExaminerViewer`, `AdminViewer`); CSRF origin checks on cookie-bearing writes; admin mutations need a step-up | `kernel/src/security.rs` (CSRF), `examcore` extractors, `admin/src/security.rs` | None known |
| **Spoofing** | A forged or replayed lease keeps an attempt "alive" | HMAC-SHA-256 lease bound to the attempt id, with a server-only key (`EXAM_LEASE_KEY`) | `examcore::issue_lease`, `verify_lease` | Key compromise (see §6) |
| **Tampering** | Changing answers after the deadline | Deadline checked in SQL under `for update`; `client_seq` ordering; `status = in_progress` required; late journal entries rejected | `exam_attempts` save path, `exam_resilience::journal` | 90 s receipt grace for verifiably offline devices (see INNOVATION §5.3) |
| **Tampering** | Editing a live paper or a grade | Papers are snapshotted at publish (`exam_items`); grades are written under lock and audited; results are signed | `exam_authoring::publish`, `exam_grading`, `examcore` signer | None known |
| **Tampering** | Editing a published result or certificate | Ed25519 signature over a canonical statement; the verify page recomputes the hash and checks the signature; unpublishing sets `revoked_at` | `exam_grading`, `/verify` | Whoever holds the signing key can sign (see §6) |
| **Repudiation** | An examiner denies changing an exam, a grade or a time credit | Audit entries for every examiner and admin state change, with the actor, target and metadata but no bodies or secrets | `kernel::security::audit`, `/admin/audit` | Audit rows are in the same database as the data they describe; exports are a copy, not a WORM store |
| **Information disclosure** | A candidate reads answer keys or rubrics | Keys are withheld from candidate payloads until results are published and the breakdown is enabled; the workspace payload has no keys | `exam_attempts` payload, `exam_grading` (`candidate_result`) | None known |
| **Information disclosure** | A user finds out whether an exam or account exists | Hidden resources return 404; password reset returns the same `202` for real and unknown emails with padded timing | `examcore::load_exam_*`, `auth/src/routes.rs` (`forgot`) | Timing is padded, not identical in every network path |
| **Information disclosure** | Cached or shared responses leak personal data | `Cache-Control: no-store` on API responses and on web pages; the proxy forces `no-store` unless upstream says otherwise | `server/src/lib.rs`, `web/next.config.ts`, `web/src/app/api/v1/[...path]/route.ts` | None known |
| **Information disclosure** | A leaked question is traced to a candidate | Invisible per-candidate watermark (opt-in per exam, on by default); decoding is an examiner action and is audited | `exam_attempts::watermark`, `exam_integrity` (`trace`) | Retyping, OCR or screenshots remove it |
| **Denial of service** | Brute force on sign-in, reset or verification | Postgres-backed fixed-window limits per subject (client IP) and per account; 5 wrong reset codes; codes expire in 15 minutes; 30 s between code resends | `kernel::security::enforce_rate_limit`, `auth/src/codes.rs`, `auth/src/routes.rs` (limits) | Shared-IP users (schools, NAT) can hit limits together |
| **Denial of service** | Oversized or deeply nested payloads, slow requests, heartbeat or event floods | 1 MiB body limit; JSON nesting check; request timeout returns 503 with `Retry-After`; heartbeats 20 per minute per attempt; events at most 50 per batch; journal 200 entries per request | `server/src/lib.rs`, `exam_resilience`, `exam_integrity` | Fixed windows allow short bursts at the boundary |
| **Denial of service** | Abuse of outbound email | Invites and resets are rate limited; sending happens after commit and a failure is never fatal | `exam_enroll`, `auth` | None known |
| **Elevation of privilege** | A candidate or examiner changes their role or identity fields | Strict input structs (`deny_unknown_fields`); role comes from the database; examiners cannot touch exams they do not own | `examcore`, `auth/src/routes.rs` (role mapping) | None known |
| **Elevation of privilege** | A compromised admin session changes accounts silently | Admin mutations require a recent step-up bound to the password hash and MFA state, and `reset-access` links are shown once and audited | `admin/src/security.rs`, `admin/src/users.rs` | A live admin session with a fresh step-up can still act |

## 3. OWASP ASVS 5.0 control mapping

ASVS 5.0 is organised into chapters V1 to V17. The mapping below lists the controls we implemented and where they
live. It is a control map to support review, not a certification claim. Chapters that do not apply are marked so.

| Chapter | Controls and file references |
| --- | --- |
| **V1 Encoding and sanitization** | Rendering goes through React, which escapes output. The API stores user text as data and never builds markup on the server. Exam stems are plain text; the watermark is an invisible character sequence, not markup |
| **V2 Validation and business logic** | Every input struct uses `#[serde(deny_unknown_fields)]`. Lengths, enums and ranges are checked in the API (`kernel`, each `exam_*` crate). Exam state rules live in `exam_authoring`. Time credit rules (1–3600 s, 3–500 character reason, caps) live in `exam_resilience/src/lib.rs` (`time_credit`) |
| **V3 Web frontend** | `web/next.config.ts` sets a Content-Security-Policy with `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'` and `connect-src 'self'`; `X-Frame-Options: DENY`; `Referrer-Policy`; and `Permissions-Policy` that disables camera, microphone and geolocation. Residual: `script-src` and `style-src` allow `'unsafe-inline'` (see §6) |
| **V4 API and web services** | The same-origin proxy (`web/src/app/api/v1/[...path]/route.ts`) forwards an allow-listed set of headers with a 1 MiB body limit and a timeout. The API applies CSRF checks, rate limits, body limits and the JSON nesting check in `server/src/lib.rs` and `kernel/src/security.rs`. Only the product routers listed in ARCHITECTURE are mounted |
| **V5 File handling** | No upload surface is mounted. The `files` crate is not on the router, and the admin file listing is read only. PDF reports are generated from server data and downloaded, never uploaded |
| **V6 Authentication** | Argon2id (`auth/src/password.rs`). Sign-in throttling in `auth/src/routes.rs`. Password reset uses a 6-digit code: random via `kernel/src/crypto.rs` `random_digits`, stored hashed, 15-minute expiry, 5 attempts (`auth/src/codes.rs`). The forgot endpoint is enumeration resistant. Self sign-up is off unless `ALLOW_SELF_SIGNUP=true`. Admin step-up in `admin/src/security.rs` |
| **V7 Session management** | Random 256-bit session tokens stored as SHA-256 (`kernel`). Cookie `__Host-session; Path=/; HttpOnly; SameSite=Lax; Secure` in production. Sign-out, sign-out-all and per-session revocation (`auth/src/routes.rs`). The attempt device lock is a separate control (`exam_resilience::takeover`) |
| **V8 Authorization** | Role extractors in `examcore`. Owner predicates in SQL (`load_exam_for_examiner`, `load_exam_for_candidate`, `where owner_id = $viewer`). A miss is 404 everywhere. Admin routes sit behind `AdminViewer` |
| **V9 Self-contained tokens** | Leases are HMAC-SHA-256 with a server key, bound to the attempt id and the deadline (`examcore::issue_lease`, `verify_lease`). Certificates are Ed25519 signatures over a canonical statement, verified on the public page. The journal hash chain is unkeyed and only detects corruption and reordering |
| **V10 OAuth and OIDC** | Not applicable. The exam product has no third-party sign-in routes mounted |
| **V11 Cryptography** | Argon2id for passwords; SHA-256 for stored session tokens, invite tokens and code hashes; HMAC-SHA-256 for leases; Ed25519 for result signatures (`examcore` signer, `RESULT_SIGNING_KEY` as a 32-byte seed); a CSPRNG for all tokens and codes. No custom cryptographic primitives |
| **V12 Secure communication** | HTTPS everywhere. `Strict-Transport-Security: max-age=63072000; includeSubDomains` from the API in production (`server/src/lib.rs`), and `max-age=31536000` from the web app (`web/next.config.ts`). The web proxy calls the API server-to-server |
| **V13 Configuration** | `APP_ENV` must be `development` or `production`. Production refuses to start without the lease and signing keys. Secrets come from the environment; `.gitignore` excludes `.env` and `.env.*` (except the example). Demo sign-in is gated by `NEXT_PUBLIC_DEMO_LOGINS` in the web app and `ALLOW_SELF_SIGNUP` in the API. The `unsafe-eval` CSP entry is development only |
| **V14 Data protection** | No camera, microphone, screen or keystroke content is collected (see §4). API responses are `no-store`. Certificates show masked facts only. Retention housekeeping removes expired sessions, codes and rate windows (`server/src/housekeeping.rs`) |
| **V15 Secure coding and architecture** | `sqlx` binds every value. The only interpolated SQL is constant column lists (`exam_questions`, `examcore::EXAM_COLUMNS`). `clippy::unwrap_used` is denied. Security regression tests live beside the code (`exam_resilience/src/security_tests.rs`, `admin/src/users.rs` tests, `server/tests/middleware.rs`). CI runs `cargo test --workspace` and `cargo clippy -D warnings` |
| **V16 Security logging and error handling** | Every request carries a request id. Errors use one envelope with no stack traces. Audit rows record actor, target and metadata, never bodies or secrets. Metrics are exposed on a loopback address only |
| **V17 WebRTC** | Not applicable. The exam uses no WebRTC, camera or microphone |

## 4. Data protection

**Personal data held.** Name, email, role, password hash (Argon2id), enrolment and accommodations, the attempt
timeline (kinds and durations of integrity events), answers and scratch work, grades and feedback, and audit rows.

**What we deliberately do not hold.** Camera or microphone data, screen captures, keystroke content or timing
biometrics, pasted text (only the count), and location. The client IP is used for rate limiting and is not profiled.

**Access.** Candidates see their own attempts and results. Examiners see only exams they own. Admins can manage
accounts, and every admin action is audited. Answer keys and rubrics are never sent to candidates before results are
published.

**Retention and deletion.** Sessions, email codes and rate-limit windows expire and are purged by housekeeping. Old
request statistics are purged as well. Accounts can be suspended, deleted and restored by an admin (soft delete).
Exam data is kept for result verification and audit, and is removed only through an admin decision. A formal
retention schedule for a production deployment is an open item for the institution that runs it.

**Transfer.** The API database is hosted on Supabase, the API on Render, the web app on Vercel and email on Resend.
Each is a processor the operator must list in its own privacy notice.

**Credentials in the demonstration environment.** The demo accounts share one password and hold fictional data
(see §6). A real deployment never runs the demo seed.

## 5. Indicator privacy stance

Integrity signals support human review. They are never evidence and never change a mark.

- **Collected:** counts and durations (focus lost, fullscreen exits, paste size in characters, typing counts per
  written answer, device locks). Each is labelled "indicators for review, not evidence" wherever it is shown.
- **Not collected:** what was typed or pasted, which keys were pressed, camera, microphone or screen.
- **Shown to:** the examiner who owns the exam, in the monitor and the integrity report.
- **Disclosed to candidates:** the lobby and the workspace state what is recorded.
- **Accessibility:** the canary sentence (opt-in) is hidden from assistive technology.
- **Decisions:** the examiner decides. A high priority only orders the queue.

## 6. Residual risks

| Risk | Why we accept it | Mitigation and next step |
| --- | --- | --- |
| **Shared demo credentials** in the demonstration environment (`Invigil#Demo2026`) | Judges need working accounts for each role, and the data is fictional | The demo seed never runs in a real deployment. Demo buttons appear only with `NEXT_PUBLIC_DEMO_LOGINS=true`. Production provisions individual accounts. Rotate the demo password after judging |
| **Offline time trust.** A modified browser can backdate entries within a valid lease, up to 90 s after the deadline, and only if it was verifiably offline at the deadline | Authorship time cannot be proven from an untrusted browser without trusted hardware | The gain is bounded to 90 s, flagged for review, and credits are human-approved and capped. See INNOVATION §5.3 |
| **`style-src` and `script-src` allow `'unsafe-inline'`** in the web CSP | Next.js inline bootstrap and theme scripts need it | In progress: a nonce-based CSP in the web layer, which removes `'unsafe-inline'` from `script-src` and `style-src`. Until it lands, the CSP still blocks framing, object embedding, foreign form targets and foreign network connections |
| **Second physical device** (a phone beside the laptop) | Invisible to any browser-only system | Indicators and takeover records. No proctoring hardware, by design |
| **Signing key compromise** (`RESULT_SIGNING_KEY`, `EXAM_LEASE_KEY`) | Keys live in the host's secret store | Keys are never in the repository. Rotation requires a new `key_id` and re-signing is not automatic. Document the rotation runbook before production use |
| **Audit rows share the database** with the data they record | A single managed database keeps the design simple | Export the audit log regularly to a store the operator controls |
| **Free-tier hosting** (Render, Supabase) can cold-start or throttle | Cost for a hackathon | A keep-alive workflow pings the API; a production deployment should use paid tiers |
| **Fixed-window rate limits** allow short bursts and can affect shared IPs | Simple and correct across replicas | Per-account budgets sit on top of the per-IP ones |

## 7. Checks run on the live deployment (27 Nov 2026)

- Security headers present on the production web app: HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, and `Permissions-Policy` with camera, microphone and geolocation disabled.
- Session cookie: `__Host-session; Path=/; HttpOnly; SameSite=Lax; Secure`.
- Password reset returns an identical `202` for real and unknown addresses.
- Uploads and AI routes are not mounted on the production API.
- Production certificate verifies with a valid Ed25519 signature.
- Supabase: row-level security enabled on all tables; `anon` and `authenticated` grants revoked.
- Local end-to-end flow: 43 of 43 checks passing against the local API.
