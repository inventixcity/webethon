RESUME CX11. You were cut off by the usage limit.

The lead has since fixed the compile error in backend/crates/exam_analytics/src/stats.rs: HiddenAdmin is now a unit struct. The endpoints compile and clippy is clean. Finish the rest:
1. Rebuild the local API (`cd C:/Users/umerf/Desktop/webethon && RUST_IMAGE=invigil-rust:dev docker compose build api && docker compose up -d api`; the lead may already have done it), then curl each endpoint:
   - GET /api/v1/exams/{id}/stats/timeseries
   - GET /api/v1/examiner/stats
   - GET /api/v1/admin-stats/overview
   Verify the data, and that non-owners and non-admins get 404.
2. Add route tests in exam_analytics for the auth (examiner owns the exam; admin-only overview) and for the bucket bounds.
3. Wire the charts to the real endpoints:
   - monitor activity-charts.tsx (live)
   - examiner-home.tsx: replace any placeholder or derived data
   - the admin overview and system pages (refresh every 30s)
4. **Monitor mobile bug** (user screenshot handoff/review/candidate/img02.png): on 390px, the candidate board's table header labels (CANDIDATE, STATUS, ANSWERED, CONNECTION, REVIEW) overlap the card content. On mobile, hide the header row and render each candidate as a clean card with label/value pairs. Also make the filter checkboxes into toggle chips there.
5. Typecheck. Screenshot the Monitor, examiner overview and admin overview at 1440 and 390, in both themes.

Finish with `STATUS: COMPLETE` in handoff/log/CX11.md; remove any older COMPLETE line first.
