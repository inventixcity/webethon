RESUME CX11. Lead decision: you are AUTHORISED and REQUIRED to finish the parts you skipped. Ownership is granted now:
- backend/crates/exam_analytics (add new handlers + tests; do not change existing handlers' behaviour) and, for admin data, add the admin endpoints in the same crate under /api/v1/admin-stats/* guarded by the admin viewer extractor (404 for non-admins). You may add a migration for indexes.
- web/src/components/monitor/** (CX9 is finished; nobody else edits it now).
Build:
1. GET /api/v1/exams/{id}/stats/timeseries?bucket=60 (examiner owns exam): per-bucket answers saved, active candidates (heartbeat in bucket), connection drops, submissions — over the exam window, capped to 500 buckets. Use existing tables (answers.updated_at / attempt events / heartbeats / audit) — inspect the schema with `docker exec invigil-postgres-1 psql -U postgres -d invigil -c "\d+ <table>"`.
2. GET /api/v1/examiner/stats (examiner): submissions per day for the last 14 days across own exams, pass rate per last 6 completed exams, candidates in exams right now.
3. GET /api/v1/admin-stats/overview (admin): sign-ins per hour last 24h (from audit log action auth.signin), active sessions now, accounts by role, exams by phase.
4. Wire charts: Monitor "Activity" chart + status stacked bar updating live (re-fetch timeseries on each SSE snapshot or every 10s); examiner overview uses endpoint 2 (replace the placeholder derived chart); admin overview/system use endpoint 3, auto-refresh 30s.
Add the TS types to web/src/lib/exam/types.ts (append a "STATS" block). Run fmt, clippy --all-targets -D warnings, crate tests; typecheck; screenshot Monitor (Databases Final + the ongoing exam), examiner overview, admin overview at 1440 and 390 in both themes.
Finish with STATUS: COMPLETE in handoff/log/CX11.md (remove the old COMPLETE line first).
