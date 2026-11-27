# Security model

| STRIDE category | Threat | Controls |
|---|---|---|
| Spoofing | Stolen credentials or forged identity | Argon2id passwords, server-side sessions, optional MFA, secure cookies |
| Tampering | Altered answers, grades or results | Transactions, row locks, answer sequence idempotency, signed verification codes |
| Repudiation | Examiner denies changing an exam | Audit records for examiner and administrator actions |
| Information disclosure | Candidate reads keys or another candidate's data | Server-side role and ownership checks; hidden resources return 404; answer keys withheld until permitted publication |
| Denial of service | Brute force, oversized payload or request flood | Rate limits, body limits and bounded timeouts |
| Elevation of privilege | Client changes role or identity fields | Rust role extractors and SQL ownership predicates govern every protected operation |

## OWASP ASVS 5.0 control mapping

| ASVS area | Implemented controls |
|---|---|
| V1 Architecture | Explicit browser/API boundary and trust proxy configuration |
| V2 Authentication | Argon2id, MFA support, rate limiting |
| V3 Session management | Server-side sessions, hashed tokens, expiry and revocation |
| V4 Access control | Role extractors, owner-scoped queries, 404 for inaccessible resources |
| V5 Validation | Strict request shapes and server-side range/length validation |
| V6 Cryptography | HMAC attempt leases and Ed25519 result signatures |
| V7 Error handling and logging | Request IDs, audit events, secret-free application logs |
| V8 Data protection | No-store API responses and controlled release of answer keys |
| V13 API and web services | CSRF/origin checks, same-origin proxy, request limits, security headers |
| V14 Configuration | Production secret validation and HTTPS response headers |

This is a control map, not a claim of formal ASVS certification.
