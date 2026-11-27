RESUME SX3. Lead updates on your blockers:
1. Migration history: fixed by the lead (the renamed 20261127009300 settings migration is now applied; the API starts). Do not edit other workers' migrations.
2. kernel/src/session.rs belongs to SX1, who is actively finishing it now. Run clippy/tests ONLY for your crates (`-p exam_grading -p exam_assist -p exam_authoring -p exam_disputes -p kernel` once it compiles); if kernel is mid-edit, retry after a few minutes rather than blocking.
3. exam_settings warning: already clean.
4. You are AUTHORISED to edit backend/crates/exam_disputes to use the same effective-marks function for dispute regrading and certificate re-signing (A1-06 completeness). Add a test.
Then finish the remaining items, rebuild the API with `docker compose build api && docker compose up -d api` (never `docker compose run`), run both e2e scripts. Remove the old STATUS line in handoff/log/SX3.md and finish with STATUS: COMPLETE.
