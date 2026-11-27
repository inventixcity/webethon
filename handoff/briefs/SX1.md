# SX1: Security fixes for accounts, sessions and enrolment (from the A1 audit). Backend.
Read handoff/reviews/A1-security-audit.md (the full sections for your IDs) and handoff/HANDOFF.md security rules first. Fix the root cause and add a regression test for each. CX13 (email templates) has just finished in these crates; build on its current code and keep its email formatting.

You own:
- backend/crates/exam_enroll, backend/crates/admin, backend/crates/auth
- backend/crates/kernel/src/session.rs
- backend/crates/records/src/account.rs
- backend/crates/exam_contact (IP hashing only)
- backend/crates/exam_analytics: the GET-mutation and stats parts listed below (CX11 has finished there)

Fix:
- **A1-01 (High).** Examiner recovery can take over a global candidate account.
  - An examiner may only (re)issue an invite for an account that has NEVER set a password and was provisioned by them for this exam (record the provisioner).
  - For established accounts, "Reset access" must instead trigger the normal self-service reset email to the candidate (silent, rate-limited), and must never return a credential or invite link to the examiner.
  - Update the web candidates panel copy only if the response shape changes (web/src/components/exams/candidates-panel.tsx: a minimal edit).
- **A1-02 (High).** Invite acceptance bypasses existing MFA. If the account has MFA enabled, invite acceptance must not create a session; require normal sign-in with MFA (or a verified TOTP step) instead. Invites for accounts with MFA should not reset credentials at all.
- **A1-03 (High).** Role changes retain sessions issued before promotion. On any role or status change (promotion, demotion, suspension), revoke all of that user's sessions in the same transaction, and audit it.
- **A1-04 (Medium).** Sliding sessions have no absolute lifetime. Add an absolute max lifetime (e.g. 12 h for candidates and examiners, 8 h for admin), enforced at lookup, alongside the idle timeout. Keep the cookie flags.
- **A1-12 (Medium).** SMTP allows opportunistic TLS. Require TLS (implicit or STARTTLS-required) for the SMTP transport. Resend over HTTPS is unaffected.
- **A1-17 (Low).**
  - The enrolment dry-run must not reveal whether an email belongs to staff or another role: return the same shape regardless.
  - Contact IP hashing must use a keyed HMAC with a server secret (not a reversible or unsalted hash).
- **A1-18 (Medium).** Self-service account deletion bypasses privileged-account safeguards.
  - Forbid DELETE /me for admin and examiner (403 with a clear message).
  - For candidates, require the current password (step-up) and refuse while an attempt is in progress or a dispute is open. Soft-delete as now.
- **A1-08 (Medium), analytics part.** An analytics GET mutates the question bank. Move that write out of the GET (compute on read, or update it during grading/publish instead).
- **A1-19 (Low).** The daily statistics depend on foreign activity. Fix examiner_overview's join, so a day's count only includes the examiner's own exams. Count the exam join in the ON clause, not as `a.id is null or e.id is not null`.

Run fmt (your crates), `clippy --all-targets -D warnings`, and the tests for each crate plus `-p server`. Rebuild the local API (`cd C:/Users/umerf/Desktop/webethon && RUST_IMAGE=invigil-rust:dev docker compose build api && docker compose up -d api`), then run `node tests/e2e/exam-flow.mjs` and `node tests/e2e/phase2.mjs`. Both must pass; update the e2e scripts only where the security change intentionally alters a flow, and say so in your log.

Write handoff/log/SX1.md (each finding ID: the change and the proving test), ending with `STATUS: COMPLETE`.
