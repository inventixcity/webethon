# R1 review — pass 3

Snapshot around 11:13. The question and grading envelopes, invite token exposure/routes, voluntary-submit journal mutation, strict outage cap, certificate republication and verify-code validation have been addressed in the current source. The resilience worker documents and tests its current journal design, including its limitations.

## BLOCKER

- `backend/crates/exam_resilience/src/lib.rs:274`: A signed lease authenticates issuance, not the time an answer was created. After the deadline a candidate can choose `elapsedMs: 0`, construct a new response and recompute the unkeyed chain for receipt during grace. Make an explicit security/product decision on this residual risk and avoid claiming that the current mechanism proves pre-deadline authorship; strict enforcement requires a trusted capture mechanism or receipt by the deadline.

## MAJOR

- `web/src/components/workspace/workspace.tsx:17`: The workspace imports missing `NetworkBanners`; its palette and top-bar props also no longer match their components (lines 112, 302 and 315). `cd web && pnpm typecheck` fails with four errors, preventing a production build. Align the imports and props with the current workspace components and rerun typecheck.
- `backend/crates/exam_grading/src/lib.rs:557`: Candidate reports return per-question marks and feedback without checking `settings.showBreakdown`. After publication, a candidate can retrieve item results via the report even when the examiner disabled breakdown. Gate per-item report data for candidate viewers on the setting.
- `backend/crates/exam_analytics/src/lib.rs:59`: The 501-row fetch and 500-row truncation apply to every statistic, not just pairwise analysis. With 501 graded candidates, counts, scores and item metrics omit a candidate. Compute aggregate statistics over all real attempts and cap only the expensive pair analysis.

Verification: `cd backend && bash scripts/cargo.sh test -p exam_resilience` passed 7 tests; `cd web && pnpm typecheck` failed with the four workspace errors listed above. Earlier `bash scripts/cargo.sh check -p exam_resilience` passed with two then-current crate warnings; source has changed since that check.

Update (11:17): C6 reports the candidate report now honors `showBreakdown`, with a regression test; current source contains the setting check. Recheck the complete integration after the concurrent edits settle.
