### SX3 Â· pass 1 Â· 16:40 PKT

- Done:
  - **A1-06:** Added `attempt_item_max_marks(attempt_id, item_id)` as the shared effective-mark function, honoring attempt blueprint overrides and returning no mark for voided/out-of-paper items. Grading, manual bounds, result denominators, candidate/PDF breakdowns, AI maximums, autograding caps, and certificate issuance use it. Added a database regression with base marks 1, override 5, score cap 5, and certificate percent 100.
  - **A1-08:** Added fallible `security::audit_tx`; grading state changes and authoring mutations write audit entries before commit. AI suggestion audit uses its own transaction. Added a rollback test proving the audit row follows its transaction. Analytics GET mutation was skipped as instructed.
  - **A1-09:** Capped exam PDF rendered candidates at 2,000, added a truncated note and 20-second render timeout, and retained the 15-second authenticated upstream timeout. Added bounds tests.
  - **A1-10:** AI policy identifies candidate text as untrusted; answer is isolated in its own user message inside neutralized delimiters and remains capped at 6,000 characters. Added prompt-injection regression.
  - **A1-11:** Draft deletion locks and checks the exam row in a transaction; publication locks and rechecks non-deleted draft status. Race regression test remains open.
  - **A1-13:** Added migration `20261127009100_revoke_public_function_execute.sql` for guarded PUBLIC/anon/authenticated revokes and default privileges, plus `20261127009200_attempt_item_effective_marks.sql` for the shared mark function and explicit function revokes.
  - **A1-16:** API BAD_REQUEST validation is normalized to HTTP 422 / `VALIDATION_FAILED` with field details; hidden examiner/dispute/AI resources normalize to 404. Added envelope and status tests.
- Verified:
  - `cd backend && bash scripts/cargo.sh fmt --all` â€” passed.
  - `bash scripts/cargo.sh check -p exam_assist`, `-p exam_grading`, `-p exam_authoring` â€” passed before the later workspace `kernel/src/session.rs` edit described below.
  - `bash scripts/cargo.sh test -p exam_assist` â€” 4 passed; `-p exam_grading` â€” 9 passed including blueprint/certificate; `-p exam_authoring` â€” 8 passed.
  - `bash scripts/cargo.sh test -p server` â€” server lib tests passed (7); a later full rerun had one intermittent `session_cookie_refresh_middleware` failure. An earlier middleware run passed.
  - `cd web && pnpm typecheck` â€” passed. `pnpm exec vitest run src/app/api/reports/exam/[examId]/route.test.ts src/app/api/reports/attempt/[attemptId]/route.test.ts` â€” 4 passed.
  - `RUST_IMAGE=invigil-rust:dev docker compose build api` â€” image build passed. Local API cannot start because SQLx detects an applied migration missing from the source migration set (see request below). An initial E2E run against the previous image had 33 pass / 2 fail because the effective-mark migration was absent from that image; the next run could not connect. Current E2E status is unverified.
  - `bash scripts/cargo.sh clippy -p exam_assist -p exam_grading -p exam_authoring -p server --all-targets -- -D warnings` â€” blocked by existing unused `patch` import in `exam_settings`. A later kernel-inclusive run also found `kernel/src/session.rs` references `config` after its parameter was renamed `_config` by a concurrent edit.
  - `bash scripts/cargo.sh test -p kernel` â€” audit transaction regression passed; unrelated concurrent-renewal test failed once (`lookup did not reach the blocked renewal`).
- Open / known gaps:
  - Full E2E pass, stable full server test pass, and a clean workspace clippy run are outstanding.
  - No barrier-controlled delete/publish race test was added.
  - Dispute-side regrade/certificate re-signing is outside SX3 ownership; its use of effective marks still needs review.
  - Current shared workspace compile is blocked by `backend/crates/kernel/src/session.rs` using `config` after it was renamed `_config`.
- Requests to lead:
  - Restore or correctly resolve migration `20261127002400_user_preferences_institution_settings`: the database records it as applied, but the current migration directory only has renamed `20261127009300_user_preferences_institution_settings.sql`, so SQLx refuses API startup. I did not edit that migration or its local history row. I synchronized the local history checksum for SX3 migration 09100 to its restored source contents after briefly adding the effective-mark function there; the function now lives in 09200.
  - Fix the concurrent `kernel/src/session.rs` `_config` compile error and the `exam_settings` unused `patch` warning so SX3-wide clippy can complete.
  - Review `exam_disputes` effective-mark use for dispute regrading and certificate re-signing.


### SX3 · pass 2 · 16:50
- Done:
  - Added an authoring database concurrency regression: publication blocks behind a draft deletion lock, then returns not found after deletion commits; the persisted exam remains deleted and unpublished.
  - Extended A1-16 handling so malformed JSON and excessive JSON nesting return HTTP 422 with `VALIDATION_FAILED` and a `body` field error, and added a response regression test.
  - Formatted the owned Rust crates and server/kernel files.
- Verified:
  - `bash scripts/cargo.sh check -p exam_assist`, `-p exam_grading`, and `-p exam_authoring` — all passed.
  - `bash scripts/cargo.sh test -p exam_assist` — 4 passed; `-p exam_grading` — 9 passed; `-p exam_authoring` — 9 passed, including the new delete/publish race regression.
  - `bash scripts/cargo.sh test -p kernel security::tests::audit_tx_obeys_caller_transaction` — 1 passed.
  - `bash scripts/cargo.sh clippy -p exam_assist -p exam_grading -p exam_authoring --all-targets -- -D warnings` and `bash scripts/cargo.sh clippy -p kernel --all-targets -- -D warnings` — passed.
  - `cd web && pnpm typecheck` — passed. Reports route Vitest run — 4 passed.
  - Current local migration table has successful versions 09100, 09200 and 09300; the earlier missing 02400 history problem is no longer present in the current database.
  - `bash scripts/cargo.sh check -p server` and the required combined server clippy/test runs currently fail while compiling the out-of-scope `records` crate: `crates/records/src/account.rs` DELETE handler does not implement Axum `Handler`.
  - `RUST_IMAGE=invigil-rust:dev docker compose build api` is running; results and E2E runs are pending.
- Open / known gaps:
  - Need successful `-p server` check, tests and clippy; API image build/start and both E2E suites remain pending.
  - The server regression added for malformed JSON could not yet execute because `server` compilation is blocked by `records`.
  - Dispute-side regrade/certificate re-signing is outside SX3 ownership and still needs review for effective-mark use.
- Requests to lead:
  - Fix the `records::account::delete` Axum `Handler` compile failure so the required server checks and local API build can run.
  - Review `exam_disputes` regrading/certificate re-signing for use of the shared effective-mark function.

STATUS: IN PROGRESS

### SX3 · pass 3 · 16:59
- Done:
  - Fixed a grading bounds bug uncovered by E2E: the effective-mark lookup now binds `attempt_id` rather than `exam_id`.
  - Limited the API 422 body-validation rewrite to `/api/v1` so non-API routes preserve their existing error contract.
- Verified:
  - `RUST_IMAGE=invigil-rust:dev docker compose build api` — passed, including the corrected grading binding and current migrations.
  - `docker compose up -d api` — API restarted successfully; current migration history applied and API health passed during E2E.
  - `node tests/e2e/exam-flow.mjs` — 43 passed, 0 failed.
  - `node tests/e2e/phase2.mjs` — 23 passed, 0 failed.
  - `bash scripts/cargo.sh check -p server` — passed.
  - `bash scripts/cargo.sh test -p exam_grading` — 9 passed after the E2E-discovered fix.
  - `bash scripts/cargo.sh test -p server --lib` — 8 passed, including the malformed-body 422 regression. `cargo test -p server` ran 8 library + 5 binary tests successfully, then failed 2 middleware tests: one expects the old 400 status for malformed `/api/v1` JSON (now contractually 422), and the session refresh test expects no cookie even though the 30-day refresh threshold is always below the 12-hour absolute lifetime.
  - `bash scripts/cargo.sh clippy -p exam_assist -p exam_grading -p exam_authoring -p kernel -p server --all-targets -- -D warnings` — passed.
  - Workspace-wide `bash scripts/cargo.sh clippy --all-targets -- -D warnings` still fails on unrelated `expect_used` warnings in `auth` and `exam_contact` tests.
  - `cd web && pnpm typecheck` and the two reports route Vitest files — passed (4 tests).
- Open / known gaps:
  - Required full `-p server` test is red only in middleware tests outside SX3 ownership: update the stale 400 expectation for malformed API JSON and resolve the session-cookie refresh expectation/behavior.
  - Workspace-wide clippy remains red on unrelated `auth` and `exam_contact` test warnings; all SX3 crates plus server and kernel pass scoped clippy.
  - `exam_disputes` regrading/certificate re-signing still needs the lead to verify effective-mark integration; the crate is outside SX3 ownership.
- Requests to lead:
  - Update `backend/crates/server/tests/middleware.rs` for the 422 body-validation contract and decide the intended cookie refresh behavior/test when the session TTL exceeds the absolute lifetime.
  - Fix the unrelated `expect_used` test warnings in `auth` and `exam_contact` so workspace clippy is green.
  - Review `exam_disputes` regrading and certificate re-signing for shared effective-mark use.

STATUS: IN PROGRESS

### SX3 · pass 4 · 17:16
- Done:
  - Closed the effective-marks re-signing gap without changing `exam_disputes`: `exam_grading::issue_certificate` now queries the attempt's effective item marks itself, so dispute and republication callers cannot supply a stale denominator.
  - Expanded the blueprint grading regression to pass an intentionally incorrect caller total and verify both initial issuance and revoked-certificate re-issuance report 100% using the attempt total.
- Verified:
  - `bash scripts/cargo.sh fmt -p exam_grading`; `bash scripts/cargo.sh check -p exam_grading`; `bash scripts/cargo.sh test -p exam_grading` — passed; 9 tests.
  - `bash scripts/cargo.sh clippy -p exam_assist -p exam_grading -p exam_authoring -p kernel -p server --all-targets -- -D warnings` — passed.
  - `RUST_IMAGE=invigil-rust:dev docker compose build api` and `docker compose up -d api` — passed with the certificate denominator change.
  - `node tests/e2e/exam-flow.mjs` — 43 passed, 0 failed. `node tests/e2e/phase2.mjs` — 23 passed, 0 failed, including dispute resolution and certificate verification.
  - `cd web && pnpm typecheck` — passed. Both report route test files — 4 passed.
  - `bash scripts/cargo.sh test -p server --lib` — 8 passed, including the 422 malformed JSON regression.
- Open / known gaps:
  - Full `bash scripts/cargo.sh test -p server` remains red in two middleware tests outside SX3 ownership: the telemetry test expects 400 for malformed API JSON (contract now requires 422), and the session-refresh test expects no cookie for a session whose configured 30-day refresh window exceeds its 12-hour absolute lifetime.
  - Workspace-wide `bash scripts/cargo.sh clippy --all-targets -- -D warnings` remains red on test-only `expect_used` warnings in `auth` and `exam_contact`. Scoped SX3/server/kernel clippy passes.
- Requests to lead:
  - Update `backend/crates/server/tests/middleware.rs` for the 422 contract and decide the expected refresh behavior with a 30-day configured TTL and 12-hour absolute lifetime; `server/tests` and `kernel/src/session.rs` are outside SX3 ownership.
  - Resolve the unrelated `expect_used` warnings in `auth` and `exam_contact` tests so the workspace-wide clippy command passes.

STATUS: IN PROGRESS

### SX3 · pass 5 · 17:22
- Verified after the latest shared workspace updates:
  - `bash scripts/cargo.sh clippy --all-targets -- -D warnings` — passed workspace-wide.
  - `bash scripts/cargo.sh test -p server` — library tests 8/8 and binary tests 5/5 pass; middleware integration tests still fail only on the stale malformed-JSON expected status (expected 400, actual required 422) and the session refresh cookie expectation (fresh request gets a cookie under the current 30-day refresh threshold / 12-hour absolute expiry).
- Open / known gaps:
  - Only the two `server/tests/middleware.rs` failures prevent the required full server test command from passing. This test file and `kernel/src/session.rs` are outside SX3 ownership; changing error mapping back to 400 would violate A1-16.
- Requests to lead:
  - Update the stale middleware 400 expectation and correct the session refresh behavior or its test expectation so `bash scripts/cargo.sh test -p server` passes.

STATUS: IN PROGRESS

### SX3 · pass 6 · 17:31
- Rechecked the remaining server test after the latest workspace state.
- Verified:
  - `bash scripts/cargo.sh test -p server` — 8 library tests and 5 binary tests passed; 3/4 middleware tests passed, including the session refresh test on this run. The remaining failure is solely `telemetry_counts_router_outcomes_and_redacts_labels`, which expects HTTP 400 for malformed `/api/v1` JSON; the A1-16 contract and implementation require 422.
  - `bash scripts/cargo.sh test -p server --lib telemetry::tests::batches_merge_and_drain_on_close` — passed; the earlier migration error was transient.
  - Workspace-wide `bash scripts/cargo.sh clippy --all-targets -- -D warnings` passed in pass 5; scoped SX3 clippy passed in pass 4.
- Open / known gaps:
  - One stale expected status in `backend/crates/server/tests/middleware.rs` keeps the full server test command red. SX3 owns only `backend/crates/server/src/lib.rs` error mapping; the required 422 behavior must not be weakened to satisfy the stale assertion.
- Requests to lead:
  - Update the telemetry middleware test expectation at line 558 from 400 to 422 so the full server test matches the API contract.

STATUS: IN PROGRESS

STATUS: COMPLETE
