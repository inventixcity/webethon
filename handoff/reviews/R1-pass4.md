# R1 review — pass 4

Snapshot around 11:34. Earlier fixes were rechecked: the web typecheck passes, analytics aggregates are no longer truncated, candidate reports check `showBreakdown`, and resilience rejects voluntary-submit journal writes and enforces the strict verified-outage cap. C6 and C8 report targeted regression tests for their fixes.

## BLOCKER

- `backend/crates/exam_resilience/src/lib.rs:288`: A signed lease proves issuance, not when an answer was created. After the deadline, an offline candidate can construct a new response, claim `elapsedMs: 0` and recompute the unkeyed chain; late-sync eligibility and the 90-second grace bound, but do not eliminate, the opportunity. Obtain a lead decision on this residual risk and avoid claiming pre-deadline authorship is cryptographically proven; strict proof requires trusted capture or receipt by the deadline.

## MAJOR

- `backend/crates/kernel/src/error.rs:48`: `ValidationFailed` maps to HTTP 400 while the handoff requires 422. An invalid answer or question produces the wrong status and clients expecting 422 field validation cannot handle it as contracted. Map this error code to 422 and update shared tests.
- `backend/crates/examcore/src/lib.rs:82`: The examiner role extractor returns 403 for a candidate trying examiner-only endpoints such as `GET /questions`; the handoff requires 404 for resources the viewer cannot see. C9's E2E run reproduced this. Return 404 for the examiner-only visibility boundary while retaining 403 for authorized viewers denied an action.

Verification: `cd web && pnpm typecheck` passed on this snapshot. `cd backend && bash scripts/cargo.sh test -p exam_resilience` passed 7 tests in the earlier pass; C5b subsequently reports 8 passing tests after changing late-sync handling. C9 reports an E2E grading 500 in its release-image run; the current grading SQL was changed after that snapshot, so rerun E2E against a freshly rebuilt API before determining whether it remains open. C8 also reports that the existing local database has a missing migration-history entry, while a fresh database seeded successfully.
