RESUME C14. Your log says COMPLETE, but two required things are missing. Remove the COMPLETE line from handoff/log/C14.md and do these:

1. The ADDENDUM at the end of handoff/briefs/C14.md is NOT implemented:
   a. In exam_grading, the candidate result (`GET /me/results/{attemptId}`, built where `"breakdown"` rows are assembled): every breakdown row must include `"itemId"` (the exam_items id, as a string) and `"voided"` (bool).
   b. In exam_disputes, the examiner view (`GET /exams/{id}/disputes`; examiner=true path of the JSON builder near line 121) must also include:
      - `"itemMarks"` (exam_items.marks or the attempts.item_marks override, as float)
      - `"awardedMarks"` (answers.manual_marks or answers.auto_marks for that attempt and item, float or null)
      - `"kind"` (exam_items.kind)
      - `"options"` (exam_items.options; the ids and texts only, NEVER `correct`)
      - `"resolvedBy"` (users.display_name of resolved_by, or null)
2. Route-level integration tests in exam_disputes (`#[sqlx::test(migrations = "../../migrations")]`, as the other exam crates do; build the router with `exam_disputes::router()` and real sessions). Cover:
   - disputing before publication gives 404
   - another candidate's attempt gives 404
   - a duplicate gives 409
   - void_item recomputes EVERY attempt's total and the effective percent
   - accept_alternative raises scores
   - regrade rejects marks above the max or off the 0.25 step
   - after resolution the certificate still verifies (`GET /verify/{code}` valid with a valid signature)
   - an examiner of another exam gets 404
3. Run `bash scripts/cargo.sh fmt -p exam_disputes -p exam_grading`, `clippy -p exam_disputes -p exam_grading --all-targets -- -D warnings`, and `test -p exam_disputes -p exam_grading`. Don't run `fmt --all`; other workers are editing other crates.
Finish with `STATUS: COMPLETE` as the last line of handoff/log/C14.md, only when all of the above pass.
