# DX1: A realistic demo dataset and a test-data cleanup. Backend seed plus one script. URGENT: we are recording the submission video right after this.
The user said: "clean up the dummy data and the data created during testing, and add real-looking data for analytics, graphs and review, in human-readable form, not hashes."

You own:
- backend/crates/server/src/main.rs (the seed functions `seed_demo_accounts`, `seed_demo_exams`, `seed_attempt` and friends)
- a new subcommand `demo-reset`, invoked like the existing seed (check how main.rs dispatches commands)
- tests/e2e/** (only to make the e2e scripts clean up after themselves)

Do NOT touch other crates. SX1 and SX3 are finishing security fixes there.

## 1. `demo-reset` command (idempotent, safe to run on production)
- In one transaction, delete everything created by tests:
  - exams titled like 'E2E exam %', 'Fair paper e2e %', 'QA TEST%', 'CX4 %', '% (copy)'
  - any exam not in the curated list below
  - all sandbox attempts
  - users with emails ending in @example.test or @example.com, plus `p2-%`, `cx1-%`, etc. Keep the three demo staff and the curated candidates.
  - Cascade through attempts, answers, events, disputes, enrollments, invites, certificates, institute_requests from tests, and audit_log rows that reference deleted objects.
- Then (re)create the curated dataset below with direct SQL, through the same helpers the seed already uses (insert_question, submit, autograde, certificate signing), so certificates verify and integrity hashes stay valid.

## 2. Curated dataset (readable, realistic, Pakistani university context, COMSATS Lahore)
- **Staff:**
  - admin@invigil.app "Invigil Admin"
  - examiner@invigil.app "Dr. Ayesha Malik"
  - a second examiner, examiner2@invigil.app "Prof. Usman Tariq"
  - candidate@invigil.app "Ali Raza"
  - All with password Invigil#Demo2026 (keep the existing demo hashes logic).
- **About 40 candidates** with realistic names (mixed gender, Pakistani plus a few international), emails like ayesha.khan@student.invigil.app and roll numbers in the display name or a field if one exists (e.g. "Hamza Iqbal (SP24-BCS-112)").
- **Question bank:** about 60 well-written questions across topics (Data Structures, Algorithms, Databases, Web Security, Operating Systems, Computer Networks), with sensible difficulty spread, real stems and options, explanations, and rubrics for the written ones. No placeholder text.
- **Exams** (titles, instructions and windows realistic; times relative to now):
  1. "CS-218 Data Structures: Final Examination": completed 6 days ago, results published, ~38 attempts with a realistic score distribution (mean ~64%, some fails), written answers graded with real feedback sentences, certificates issued, 2 disputes (one accepted with an item voided or mark changed, one rejected with a reasoned note).
  2. "CS-341 Database Systems: Midterm": completed 2 days ago, graded, **results NOT published** (shows "awaiting results"), with integrity events (focus loss, paste) on a few candidates so the integrity panels and the review priority show data, and one verified outage credit.
  3. "CS-305 Web Security: Quiz 2": **ongoing NOW**. The window started 20 min ago and ends in 3 hours. ~25 enrolled, ~12 in progress with answers saved spread over the last 20 minutes (heartbeats and answer timestamps spread out, so the Monitor activity chart and the "candidates now" sparkline have shape), 6 submitted, the rest not started. Make sure candidate@invigil.app is enrolled and NOT started, so the video can start it live.
  4. "CS-220 Algorithms: Practice Test": scheduled to open tomorrow, published.
  5. "CS-330 Operating Systems: Final": draft with questions assigned and a fair-paper blueprint configured (for the review screen).
  6. "CS-356 Computer Networks: Lab Quiz": completed 10 days ago, published.
- Spread submissions across the last 14 days, so the "Submissions per day" chart has bars on several days, and pass rates per exam vary.
- **Sign-in audit entries** spread over the last 24 h, so the admin "sign-ins per hour" chart has shape.
- **3 institute requests** with realistic content, e.g.:
  - "University of the Punjab, Department of CS", 1,200 candidates, status contacted
  - "LUMS School of Science and Engineering", new
  - "FAST-NUCES Lahore", onboarded
- **Announcements:** one on the ongoing exam.
- Nothing visible may show raw ids or hashes as names or titles.

## 3. Make the e2e scripts clean up after themselves (delete their exams and users at the end), so tests stop polluting data.

## 4. Verify
- Run fmt, `clippy -p server --all-targets -D warnings` and `cargo test -p server`.
- Rebuild the local API (`cd C:/Users/umerf/Desktop/webethon && RUST_IMAGE=invigil-rust:dev docker compose build api && docker compose up -d api`).
- Run `demo-reset` against the local DB the same way the seed runs; check the Dockerfile and compose for how to invoke the binary with a subcommand, e.g. `docker compose run --rm --no-deps api /app/server demo-reset` (here, a one-off run for the seed command IS allowed).
- Check in the browser (shots-theme.mjs in the scratchpad) that the examiner overview, an exam's Monitor, Analytics, Results and Disputes, the admin overview, Requests and the candidate dashboard all show the new readable data with charts that have shape.
- Write the exact production command into handoff/log/DX1.md: how to run demo-reset against DATABASE_URL from .env.production using the local docker image, without printing secrets.

Write UTF-8 only. Finish with `STATUS: COMPLETE` in handoff/log/DX1.md.
