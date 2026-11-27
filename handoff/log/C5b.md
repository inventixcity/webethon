### C5b · pass 1 · 11:20
- Done: Bound journal receipt grace to a crate-local 90 seconds. Entries received after the deadline now require no heartbeat in the preceding 30 seconds and successful late syncs are recorded in `attempt_events` as notice-level `journal_synced` events with `lateSynced`. Updated the threat-model comment with the maximum 90-second gain and offline-at-deadline condition. Verified submitted attempts already reject entries as `closed`; cumulative non-admin credit logic already enforces the strict uncredited-outage cap with no tolerance. Added a database test for late receipt acceptance visibility and rejection when a heartbeat proves connectivity near the deadline.
- Verified: `cd backend && bash scripts/cargo.sh fmt -p exam_resilience` — passed. `cd backend && bash scripts/cargo.sh check -p exam_resilience` — passed. `cd backend && bash scripts/cargo.sh test -p exam_resilience` — passed, 8 tests. `cd web && pnpm typecheck` — passed. `cd web && pnpm test` — passed, 206 tests.
- Open / known gaps: Cargo emits five existing unused workspace dependency warnings outside this crate. No C5b source warnings were reported.
- Requests to lead: None.

STATUS: COMPLETE
