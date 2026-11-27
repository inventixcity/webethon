# R1 review — pass 1

Snapshot: C4 reported a partial implementation; other crates were still scaffolds or in progress. Findings reflect the source at review time.

## MAJOR

- `backend/crates/exam_attempts/src/lib.rs:148`: The start helper checks the late-join window before looking up an existing attempt. A candidate who starts on time and reconnects after `lateJoinMinutes` receives a conflict even while their attempt deadline is in the future. Look up and return an existing attempt before applying new-start window checks, while retaining enrollment and ownership checks.
- `backend/crates/exam_attempts/src/lib.rs:10`: The router is empty, so all candidate dashboard, attempt, answer, submit, scratch and preference routes return 404. A candidate cannot take or submit an exam. Implement and register the contract handlers, with the required authorization, locking, validation and deadline checks.

- `backend/crates/exam_questions/src/lib.rs:302`: Question handlers serialize their payloads directly, without the required `{data: ...}` envelope; `api()` returns `undefined` for successful list, create and edit calls. Wrap each successful question response in the contract envelope.

## BLOCKER

- `web/src/lib/exam/journal.ts:93`: Concurrent offline saves read the same metadata before either write, then both use the same `[attemptId, seq]` key; one answer overwrites the other. Serialize append operations per attempt and atomically allocate sequence/head with the entry write.
- `web/src/lib/exam/use-attempt.ts:57`: Submission does not flush the 800 ms answer debounce or await in-flight saves. A candidate who answers and immediately submits can finalize before the latest answer is stored, permanently losing it. Flush pending timers and await all saves and journal sync before finalizing, including at the deadline.

- `backend/crates/exam_resilience/src/lib.rs:175`: A non-admin can grant `allowed + 60` seconds repeatedly, even with no verified outage: the credit row may omit outage bounds, and prior credits are not deducted. An examiner can extend an attempt indefinitely by repeating requests. Require a verified, uncredited outage and atomically cap cumulative credits against its duration under the attempt lock.
- `backend/crates/exam_resilience/src/lib.rs:119`: Journal saves use `1_000_000_000 + journal seq`, while subsequent online saves use the browser's small `clientSeq`. After reconnect, every later online edit to that item is silently rejected as stale, so the candidate's final answer is lost. Use one monotonic sequence scheme across online and journal saves and surface stale rejections.

- `backend/crates/exam_grading/src/lib.rs:330`: Republishing after unpublishing leaves the existing certificate revoked because `on conflict(attempt_id) do nothing` never issues a replacement. Candidates then cannot access their republished results and the public code remains revoked. Issue a fresh certificate on republication while preserving revoked historical certificates.
- `backend/crates/exam_grading/src/lib.rs:414`: The public verify code is sliced at byte offsets without restricting it to ASCII; a 12-byte string whose multibyte character crosses offset 4 or 8 panics the request task. Validate the code's ASCII alphabet and exact shape before slicing.
- `backend/crates/exam_grading/src/lib.rs:346`: Grading and result handlers return raw JSON instead of `{data: ...}`. The shared client therefore returns `undefined` for successful grading, results and verify requests, breaking those screens. Wrap each response in the required envelope.
- `backend/crates/exam_integrity/src/lib.rs:42`: Integrity event detail accepts arbitrary short string keys and values, which are persisted and exposed in reports. A client can send answer or clipboard content as detail, violating the count-only privacy rule. Allowlist per-event numeric/boolean fields and reject content-bearing strings.

Update (10:43 snapshot): `journal.ts` now serializes entry allocation and updates `clientSeq`; recheck its integration with `use-attempt.ts` and server replay before closing those two journal findings. The save queue is being rewritten while this review is in progress.
- `backend/crates/exam_enroll/src/lib.rs:505`: Invite acceptance returns the raw session token in JSON as well as the HttpOnly cookie. Any script running on the origin can read and export that bearer credential, defeating HttpOnly protection. Return only the user data and set the session exclusively in the cookie.
- `backend/crates/exam_enroll/src/lib.rs:519`: Invite routes are mounted at `/invites/...`, while the handoff contract specifies `/auth/invites/...`. Contract-compliant clients receive 404 and cannot activate accounts. Mount the specified paths and update the invite UI consistently.
