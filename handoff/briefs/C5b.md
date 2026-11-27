# C5b: exam_resilience follow-ups (you own backend/crates/exam_resilience/** and web/src/lib/exam/{journal,sync,use-attempt,network,device,clock}.ts after S2)
Read handoff/briefs/C5.md, handoff/log/S2.md, handoff/reviews/R1-pass2.md (the exam_resilience BLOCKERs) and the code. Fix every item S2 left open, plus:
1. BLOCKER: the journal must REJECT entries (reason `closed`) for attempts the candidate SUBMITTED (status submitted). The grace window applies only to attempts that are in_progress, or expired by the timer. The client already flushes the journal before submit.
2. BLOCKER: the time-credit cap. A non-admin examiner may grant at most the total UNCREDITED verified outage seconds (no +60 tolerance), counting all previous credits cumulatively. Admins may exceed it, with an audited reason.
3. BLOCKER (inherent; bound it and make it visible): `elapsedMs` is client-controlled, so after the deadline a candidate could fabricate an entry backdated within the grace window.
   - Mitigations:
     - (a) reduce `JOURNAL_GRACE_SECS` usage for the journal to 90 s, using a local constant in your crate
     - (b) an entry RECEIVED after the deadline is accepted only if the server saw no heartbeat in the 30 s before the deadline (the device was verifiably offline at the deadline); otherwise reject it as `late`
     - (c) record each accepted post-deadline entry as an `attempt_events` row of kind `journal_synced`, severity notice, with detail `{lateSynced: n}`, so the examiner sees it
   - Document the bound (max gain <= 90 s, and only when verifiably offline) in the threat-model doc comment.
4. Tests for each. Run fmt, check and test for exam_resilience, and `cd web && pnpm typecheck && pnpm test`.
Finish with `STATUS: COMPLETE` as the last line of handoff/log/C5b.md.
