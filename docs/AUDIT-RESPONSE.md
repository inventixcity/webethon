# Response to the external review

This page answers the external review's findings and its 20-item checklist. Each item has a status, the evidence
for it, and the next step. Status values:

- **Resolved:** fixed, and the fix is in code or in the live deployment.
- **Mitigated:** the risk is reduced, and a residual is stated.
- **Accepted risk:** a known risk we keep on purpose, with the reason given.
- **In progress:** a fix is underway and not yet merged.
- **Open:** not yet addressed.

Evidence references are files in this repository, tests, or live checks made on 27 November 2026.

## Findings

| # | Finding | Status | Evidence | Next step |
| --- | --- | --- | --- | --- |
| F1 | **Fixed demo credentials** | Mitigated (accepted risk in the demo environment) | The seed (`backend/crates/server/src/main.rs`) creates demo accounts with one shared password. The demo sign-in buttons render only when `NEXT_PUBLIC_DEMO_LOGINS=true` (`web/src/app/(auth)/login/page.tsx`). The seed is a separate command and is not run at API start. The README and DEMO.md state that demo accounts hold fictional data | Rotate the demo password after judging. Production provisions accounts individually and sets `NEXT_PUBLIC_DEMO_LOGINS=false` |
| F2 | **Offline grace authorship** | Mitigated (residual accepted) | A post-deadline journal entry is accepted only if it was stamped before the deadline, arrived within `JOURNAL_RECEIPT_GRACE_SECS = 90`, and the device had no heartbeat in the final 30 s (`backend/crates/exam_resilience/src/lib.rs`, `journal`). Such entries are counted as `lateSynced` and logged as a notice. Credits are capped at verified outage time. The threat model is in INNOVATION §5.3 | Examiners review `lateSynced` notices. Whether to shorten the window or require trusted capture is a policy decision, recorded as a residual |
| F3 | **The system is unverified end to end** | Resolved | Local end to end: `tests/e2e/exam-flow.mjs` passes 43 of 43 checks against the local API. Production is deployed: web at `https://invigil-ivory.vercel.app`, API at `https://invigil-api.onrender.com`. Live checks passed for security headers, cookie flags, the identical reset response, the absence of uploads and AI routes, and a certificate signature | Run the end-to-end script against the production API once before the demo. This was not yet recorded as a run |
| F4 | **AI spend cap** | Resolved (by removal) | The API does not mount the AI router (`backend/crates/server/src/lib.rs`, `build_router`). No code path calls a model provider, so there is no spend. The `ai_usage` table exists but is unused | If AI routes are re-enabled, add a per-user and global spend cap first, and test it |
| F5 | **CSP `'unsafe-inline'`** | In progress | `web/next.config.ts` allows `'unsafe-inline'` in `script-src` and `style-src`. The only inline script is the fixed theme bootstrap (`web/src/components/theme/theme-script.tsx`), which takes no user content. Another worker is adding a nonce-based CSP | Merge the nonce CSP, remove `'unsafe-inline'` from both directives, and check the browser console on every screen |
| F6 | **PDF uploads** | Resolved | No upload surface is mounted. The `files` crate is not on the router, and the admin file listing is read only. PDF reports are generated on the server from exam data and only downloaded (`web/src/app/api/reports/**`) | None, unless uploads are added. Any new upload must get its own review |
| F7 | **Demo UX and accessibility** | Open (partly addressed) | Layouts were reworked, and the shared controls (`web/src/components/ui/*`) carry `aria-*` attributes. The workspace has keyboard and reduced-motion support. A full accessibility audit has not been done | Run an audit with an automated checker and a keyboard and screen-reader pass on the candidate workspace, the examiner monitor and the login flow |

## The 20-item checklist

| # | Check | Status | Evidence | Next step |
| --- | --- | --- | --- | --- |
| 1 | API keys hidden from the client | Resolved | Only two `NEXT_PUBLIC_` variables are read in `web/src` (`NEXT_PUBLIC_API_ENABLED`, `NEXT_PUBLIC_DEMO_LOGINS`), and both are booleans. `API_ORIGIN` and `PROXY_SECRET` are server-only | None |
| 2 | Environment variables | Resolved | Secrets are read from the environment. `.env.example` files hold placeholders only. The API refuses production startup without the lease and signing keys. Docs list the variables in README | None |
| 3 | Keys in git | Mitigated | `.gitignore` excludes `.env` and `.env.*` except the examples. `git ls-files` lists only `.env.example`, `backend/.env.example` and a Lottie asset. The compose file contains labelled development-only values for the lease and signing keys | Confirm in production that the API rejects the development key values (not tested here, so this is Mitigated in practice) |
| 4 | Admin routes | Resolved | Every `/admin` route takes `AdminViewer`. Mutations need a fresh step-up bound to the password hash and MFA state (`backend/crates/admin/src/security.rs`). Tests in `backend/crates/admin/src/users.rs` check that users routes require admin and that mutations require step-up | None |
| 5 | Authentication | Resolved | Argon2id (`backend/crates/auth/src/password.rs`). Sign-in and reset rate limits. Reset is enumeration resistant (`auth/src/routes.rs`, `forgot`). Self sign-up is off unless `ALLOW_SELF_SIGNUP=true`. Live: identical `202` for real and unknown emails | None |
| 6 | Permissions (authorization) | Resolved | Owner predicates in SQL (`examcore::load_exam_*`, `where owner_id = $viewer`). A miss returns 404. Security regression tests in `exam_resilience/src/security_tests.rs` and the exam crates | None |
| 7 | Input validation | Resolved | `#[serde(deny_unknown_fields)]` on input structs. Ranges and lengths checked in the API. 1 MiB body limit and JSON nesting check (`backend/crates/server/src/lib.rs`). Validation errors return 422 with details | None |
| 8 | XSS | Mitigated | React escapes all rendered text. The only `dangerouslySetInnerHTML` is the fixed theme bootstrap script. The CSP still allows inline scripts (F5) | Complete F5 |
| 9 | SQL injection | Resolved | Values are bound with `sqlx`. The only interpolated SQL is constant column lists (`exam_questions`, `examcore::EXAM_COLUMNS`) | None |
| 10 | Database rules | Resolved | Row-level security on every table with no policies, and `anon` and `authenticated` grants revoked (`backend/migrations/20261127009000_supabase_lockdown.sql`). Live check by the lead on 27 Nov | None |
| 11 | Rate limiting | Resolved | Postgres-backed fixed windows per subject, using the trusted client IP (`kernel::security::enforce_rate_limit`), plus per-attempt and per-user budgets in the feature crates (for example heartbeats 20 per minute, journal 30 per minute) | None |
| 12 | AI spend cap | Resolved (not applicable) | AI routes are not mounted (F4) | None |
| 13 | File uploads | Resolved (not applicable) | Uploads are not mounted (F6) | None |
| 14 | CSRF | Resolved | `Sec-Fetch-Site` and `Origin` checks on cookie-bearing state-changing requests (`backend/crates/kernel/src/security.rs`) | None |
| 15 | CORS | Resolved | No CORS is needed. The browser calls a same-origin proxy, and the API sends no `Access-Control-Allow-*` headers | If a second origin is ever needed, add an explicit allow-list and never combine a wildcard with credentials |
| 16 | HTTPS | Resolved | Vercel and Render serve HTTPS. The API sends HSTS in production (`server/src/lib.rs`). Live: HSTS is present on the web app | None |
| 17 | Security headers | Mitigated | Live: HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera, microphone and geolocation disabled). The CSP has `'unsafe-inline'` (F5) | Complete F5 |
| 18 | Secure cookies | Resolved | Live: `__Host-session; Path=/; HttpOnly; SameSite=Lax; Secure` | None |
| 19 | Debug mode | Resolved | `APP_ENV` must be `development` or `production` (`kernel` config). Production runs with `APP_ENV=production` (`render.yaml`). The `unsafe-eval` CSP entry is development only (`web/next.config.ts`). Errors use one envelope and no stack traces | None |
| 20 | Production settings | Mitigated | `render.yaml` sets `APP_ENV=production`, `RUN_MIGRATIONS`, `TRUSTED_PROXY_HOPS=1`, and binds metrics to loopback. Gaps: `render.yaml` refers to `deploy/render/README.md`, which is not in the repository, and the Render deploy trigger is not scripted in the repo | Add the Render runbook, or remove the reference, and script the deploy step |

## Summary

- **Findings:** Resolved: F3, F4, F6. Mitigated: F1 (accepted risk in the demo environment) and F2. In progress: F5
  (nonce CSP). Open: F7 (full accessibility audit).
- **Checklist:** Resolved: items 1, 2, 4 to 7, 9 to 16, 18 and 19. Mitigated: items 3 (production key check untested), 8 (XSS, until F5 lands), 17 (headers,
  until F5 lands) and 20 (production runbook gaps).
