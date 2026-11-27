# SX2: Security fixes for exam integrity (from the A1 audit). Backend only.
Read handoff/reviews/A1-security-audit.md (the full sections for your IDs) and handoff/HANDOFF.md security rules first. Fix the root cause, add a regression test for each, and keep API contracts unchanged unless the finding requires otherwise (note any change in handoff/HANDOFF.md under the API contract).

You own:
- backend/crates/exam_resilience
- backend/crates/exam_integrity
- backend/crates/exam_attempts
- backend/crates/exam_questions
- the journal and receipt helpers in backend/crates/examcore

Fix:
- **A1-05 (High).** Published answers can be reopened, and publication and recovery are not serialised. Lock the exam and attempt rows (FOR UPDATE) in both paths. Refuse any reopen, recovery or journal sync on an attempt whose results are published, or whose grading is finalised (409 with a clear code).
- **A1-21 (Medium).** The offline receipt proves a lease, not when an answer was written. Bind each journal entry's write time to the hash chain and lease. Reject entries whose claimed time is after the deadline plus grace, or outside the lease window. Keep the 90 s grace rule from HANDOFF exactly.
- **A1-07 (Medium).** Enforce the fairness tolerance when draw retries fail: fail closed with a clear error, never hand out an out-of-tolerance paper. Keep the publish-time feasibility check consistent with this.
- **A1-15 (Low).** The SSE authorisation recheck queries a nonexistent column. Fix the query, and add a test that the stream closes when the session is revoked or ownership changes.
- **A1-14 (Low).** Add deny_unknown_fields on query structs in exam_questions. Enforce the written-answer word limit server-side in exam_attempts and resilience saves (422 with a field error).

Run fmt (your crates only), `clippy --all-targets -D warnings`, and the tests for every crate you touch, plus `bash scripts/cargo.sh test -p server`. Then run the e2e suites: `node tests/e2e/exam-flow.mjs` and `node tests/e2e/phase2.mjs` against the local stack, after rebuilding the API with `cd C:/Users/umerf/Desktop/webethon && RUST_IMAGE=invigil-rust:dev docker compose build api && docker compose up -d api`. Both must pass.

Write handoff/log/SX2.md (each finding ID: what changed, and which test proves it), ending with `STATUS: COMPLETE`.
