# R1 review — pass 2

Snapshot around 10:51. Pass 1 findings are historical; question response envelopes and journal allocation/save queue have since been revised, and require integration tests. The original unrestricted repeated credit issue was narrowed, but the cap still has the issue below.

## BLOCKER

- `backend/crates/exam_resilience/src/lib.rs:122`: The journal accepts entries for `submitted` attempts during the grace window and writes answers at line 144. A candidate can submit and then send a valid pre-deadline lease-stamped entry to change the finalized answer. Reject new entries after voluntary submission; only permit explicitly defined timer-expiry recovery and regrade under the same lock.
- `backend/crates/exam_resilience/src/lib.rs:210`: Non-admin credits may exceed verified outage time by 60 seconds, contrary to the specified cap. For a verified 45-second outage an examiner can grant 105 seconds. Remove the tolerance and bound cumulative credits by verified uncredited outage duration.

## MAJOR

- `backend/crates/exam_grading/src/lib.rs:342`: Republishing after revocation still leaves certificates revoked due to `on conflict(attempt_id) do nothing`; candidate result access remains unavailable. Issue a fresh active certificate while preserving revoked verification history.
- `backend/crates/exam_grading/src/lib.rs:237`: Result and grading handlers still return raw JSON; `api()` unwraps `data` and thus returns undefined. Wrap every success response using `examcore::ok`.
- `backend/crates/exam_grading/src/lib.rs:429`: Public verify slices the normalized code at byte offsets without first ensuring ASCII; a 12-byte Unicode string can panic at a non-character boundary. Validate the allowed ASCII code alphabet and length before slicing.
- `backend/crates/exam_analytics/src/lib.rs:68`: Discrimination subtracts raw awarded marks, although the contract requires a -1..1 index. On a 10-mark item, upper and lower group means of 10 and 0 produce 10. Normalize each awarded score by item marks before computing the group difference.
- `backend/crates/exam_analytics/src/lib.rs:26`: All summary and item statistics silently use only the latest 500 graded attempts. With 501 candidates the headline count, pass rate, and item metrics omit one candidate; only pairwise comparisons need a cap. Aggregate over all real attempts and cap only the expensive pair analysis.

Update (10:55): grading success handlers now use `examcore::ok`; the envelope finding above is resolved in the current source. C3's log reports fixes for both invite findings from pass 1.

## Additional BLOCKER

- `backend/crates/exam_resilience/src/lib.rs:275`: A signed lease proves issuance time, but `elapsedMs` is client-controlled and has no trusted lower bound. A candidate can wait until after the deadline, then submit a newly constructed answer with `elapsedMs: 0`, `writtenAt: lease.issuedAt`, and a recomputed unkeyed hash; the server accepts it during grace. Do not represent this scheme as proving when an offline answer was written; require a trusted capture mechanism or restrict late synchronization and explicitly treat the resulting timing assurance as a product/security decision.

Update (11:03): resilience now rejects voluntary-submit journal writes and removes the credit tolerance; `cd backend && bash scripts/cargo.sh test -p exam_resilience` passed 7 tests. Grading source now checks ASCII verify codes and issues a new certificate after revocation; confirm migration/integration behavior before closing those findings.

## Additional MAJOR

- `backend/crates/exam_grading/src/lib.rs:557`: The candidate report always returns per-question stems, awarded marks and feedback, even when exam `showBreakdown` is false. A candidate can request the report endpoint or PDF to bypass the examiner's breakdown setting. Gate or omit per-item report data for candidates unless the setting permits it; retain the examiner view.
