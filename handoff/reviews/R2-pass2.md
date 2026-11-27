# R2 - Phase 2 review - pass 2 - 14:33 PKT

## Open findings

The four grading/fairness/privacy findings and the All filter finding in `handoff/reviews/R2-pass1.md` still reproduce by inspection: pool/attempt denominators and per-item caps disagree (`backend/crates/exam_grading/src/lib.rs:244`, `backend/crates/exam_grading/src/lib.rs:846`, `backend/crates/exam_disputes/src/lib.rs:299`); multi-select alternatives alter the existing answer key (`backend/crates/exam_grading/src/lib.rs:812`); draws do not enforce pairwise tolerance (`backend/crates/exam_attempts/src/lib.rs:315`); personal data can pass through model prompt fields (`backend/crates/exam_assist/src/lib.rs:75`); and All sends an invalid status (`web/src/components/disputes/disputes-view.tsx:48`). Scenarios and proposed fixes are in pass 1.

- **MAJOR - Overlapping blueprint rows may prevent starts after publish.** `backend/crates/exam_attempts/src/lib.rs:281` greedily consumes the first matching row and immediately fails on its first unsuccessful ordering at `backend/crates/exam_attempts/src/lib.rs:303`, even though a different assignment can satisfy the blueprint. A broad row drawing a difficult item can starve a later narrow row. Validate feasibility globally before publication and use a matching/assignment algorithm or retry all candidate variants before declaring infeasibility; test overlapping rows with valid and invalid allocations.
- **MAJOR - All items voided causes division by zero.** `backend/crates/exam_grading/src/lib.rs:248` divides score by a pool total that becomes zero after voiding the final item. The resolution can commit, after which examiner results/report fail; certificate percent calculation at `backend/crates/exam_grading/src/lib.rs:399` also lacks a zero-total policy. Define an explicit all-void outcome and apply it consistently to result, pass and certificate flows, with a resolution/verification regression test.

## Rechecked

- The SSE proxy finding is fixed in `web/src/app/api/v1/[...path]/route.ts:70`; no long-duration browser test was run.
- Earlier disputes test compilation failure was transient: `cd backend && bash scripts/cargo.sh test -p exam_disputes` now passes 5 tests. `bash scripts/cargo.sh test -p exam_resilience` passes 9; `bash scripts/cargo.sh test -p exam_integrity` passes 4. Pass 1 recorded grading, assist and web typecheck results.
- Bulk credit now subtracts previously credited time intervals under attempt locks and caps the extended deadline; no additional cap bypass established by inspection. Live stream rechecks session and releases its per-process permit on drop. End-to-end stream lifetime, reauthentication and concurrency still need testing.
