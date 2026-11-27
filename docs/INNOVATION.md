# Innovation: resilient exams and AI-era integrity

## 5.3 Failure-resilient delivery

Attempt state belongs to the server. Deadlines are calculated from server time and include explicitly granted accommodations. Answer saves use client sequence numbers, submission is idempotent, and a periodic sweep finalizes attempts whose deadline and journal grace have passed. The client journal can replay locally queued answers after connectivity returns. These choices allow recovery without trusting a candidate's clock or silently pausing an exam.

Trade-offs include eventual synchronization rather than instant acknowledgement while offline, and a bounded grace interval before finalization. A device takeover remains an auditable integrity signal. Persistent outages still require an examiner to review the recorded context and decide whether an accommodation is appropriate.

## 5.1 Integrity in the AI era

Question and response integrity signals, optional watermark/canary settings and examiner monitoring help locate unusual patterns for review. Optional AI grading can suggest marks for written responses, while rubric-based examiner grading remains authoritative. Signals are explicitly indicators for review, not evidence and never automatic verdicts.

Trade-offs include false positives, accessibility impacts from device/fullscreen controls and the risk that determined candidates evade signals. AI suggestions can be wrong or biased and must be reviewed. Residual risks include compromised candidate devices, collusion, service/provider outages and leaked exam content. Invigil keeps grading decisions and authorization server-side and leaves final judgments with examiners.
