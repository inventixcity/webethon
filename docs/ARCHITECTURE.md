# Architecture

The browser calls the same-origin `/api/v1/*` proxy, which forwards to the Rust API. The API performs role and ownership authorization, validation, rate limiting, auditing, deadline checks and result publication. PostgreSQL stores identities, exams, question snapshots, enrollments, attempts, answer journals and audit events. `examcore` contains shared role extractors, scoring, lease and signing helpers.

Attempt writes run in transactions and serialize on the attempt row. Start and submit are idempotent. A periodic worker sweeps attempts past their server-calculated deadline plus journal grace. Client clocks are informational only. A local answer journal allows interrupted clients to resume synchronization.

The web app is hosted on Vercel. Azure Container Apps hosts the API image built by Azure Container Registry. `/healthz` is a liveness endpoint and `/readyz` checks database readiness. PostgreSQL is the durable source of truth.
