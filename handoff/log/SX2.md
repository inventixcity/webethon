
### SX2 · pass 1 · 16:45
- Done:
  - **A1-05:** Journal sync and single/bulk time-credit recovery now lock the exam before the attempt, matching publication's exam-first lock order. They return 409 `results_finalized` when results are published or an attempt's grading is complete. `published_or_finalized_results_block_journal_and_recovery` covers journal sync and both recovery paths in published and finalized states.
  - **A1-21:** Added `examcore::verify_lease_write_time`; journal acceptance checks the claimed timestamp is at/after lease issue, matches `issued_at + elapsed_ms`, and is within the signed lease. The timestamp remains committed by `chain_next`. Receipt still uses the 90-second rule. `lease_chain_time_bounds_and_replay` covers rehashed timestamp tampering and invalid elapsed/window bounds; `post_deadline_journal_requires_offline_proof_and_is_visible` and `late_entries_grace_and_broken_suffix` cover the grace behavior.
  - **A1-07:** Paper draws now return 409 `fairness_unavailable` when 200 retries fail the configured tolerance. `blueprint_draw_fails_closed_when_every_paper_exceeds_tolerance` confirms no attempt is inserted. Draw-time enforcement matches the existing preview tolerance calculation. Publish-time feasibility lives in `exam_authoring`, outside SX2 ownership.
  - **A1-15:** Replaced the invalid `users.suspended_at` query with active/deleted/role checks and added deleted-exam and owner predicates. `monitor_recheck_closes_on_session_revocation_or_owner_change` opens actual SSE streams and confirms they close after session revocation and owner transfer.
  - **A1-14:** `ListQuery` denies unknown fields. Written response validation now enforces `maxWords` via whitespace-separated word count while retaining the prior character ceiling. `list_query_rejects_unknown_parameters`, `answer_save_rejects_excess_words_with_a_field_error`, `written_answer_enforces_word_count_even_when_characters_are_short`, and `journal_save_enforces_written_answer_word_limit` cover these cases. The shared server middleware maps validation to 422; crate-local route tests observe the kernel's underlying 400.
- Verified:
  - `cd backend && bash scripts/cargo.sh fmt -p exam_attempts -p exam_resilience -p exam_integrity -p exam_questions -p examcore` — passed.
  - `cd backend && bash scripts/cargo.sh check -p exam_attempts -p exam_resilience -p exam_integrity -p exam_questions -p examcore` — passed.
  - `cd backend && bash scripts/cargo.sh clippy -p exam_attempts -p exam_resilience -p exam_integrity -p exam_questions -p examcore --all-targets -- -D warnings` — passed.
  - `cd backend && bash scripts/cargo.sh test -p exam_attempts -p exam_resilience -p exam_integrity -p exam_questions -p examcore` — passed: 27 + 11 + 5 + 7 + 5 tests.
  - `cd backend && bash scripts/cargo.sh test -p server` — passed: 6 library tests, 5 binary tests, 4 middleware tests.
  - `$env:RUST_IMAGE='invigil-rust:dev'; docker compose build api` and `docker compose up -d api` — image built; normal API container entered a restart loop because its embedded migration set omitted migration 20261127002400 already recorded in the DB. `api migrate`/startup applied through 20261127009200, then I ran the API with `RUN_MIGRATIONS=false` against the updated local schema so e2e could run.
  - `node tests/e2e/phase2.mjs` — passed, 23 passed / 0 failed / 0 skipped.
  - `node tests/e2e/exam-flow.mjs` — 33 passed / 2 failed / 8 skipped. Both failures are in the non-SX2 grading handler: its `attempt_item_max_marks` query binds `exam_id` as `$2` where it must bind `attempt_id`, so it returns 404 for valid grading requests. Reproduced after rebuilding the API and applying the local migration.
- Open / known gaps: A1-07 publish-time tolerance feasibility must be aligned in `exam_authoring`; SX2 could not edit that crate. The requested full e2e gate is not green because of the grading query defect above and the local image migration-set mismatch.
- Requests to lead:
  1. In `backend/crates/exam_grading/src/lib.rs`, bind `attempt_id` as the second parameter to `attempt_item_max_marks` in `grade_answer`; rerun `node tests/e2e/exam-flow.mjs`.
  2. Align publish-time blueprint feasibility in `exam_authoring` with the draw/preview tolerance rule.
  3. Fix the API image's embedded SQLx migration set so applied migration 20261127002400 is present; a normal `docker compose up -d api` currently restarts with “previously applied but missing in resolved migrations.”
- STATUS: COMPLETE
