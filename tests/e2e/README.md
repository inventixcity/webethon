# Black-box API tests

Requires Node 24, a running API, Postgres and Mailpit configured as the API's SMTP sender. No npm installation is needed. Tests create real users, records, sessions, and audit entries; use a disposable environment, never production. `ADMIN_EMAIL` must be included in the API's `ADMIN_EMAILS` configuration. Set both `ADMIN_EMAIL` and `ADMIN_PASSWORD` to enable the administrative suspension test; it creates and suspends a disposable account.

```sh
node --test 'tests/e2e/lib/*.test.mjs'
node --test 'tests/e2e/*.test.mjs'
node tests/e2e/run.mjs
```

`run.mjs` runs files serially, rate-limit tests last, and prints a table. Node's glob discovery may run files concurrently and does not guarantee the `zz` file runs last. Node 24.12 on Windows treats `node --test tests/e2e/` and `node --test tests/e2e/lib/` as module paths rather than discovering tests; use the quoted glob commands above. The helper exposes `clearMail()` using Mailpit's DELETE endpoint, but tests intentionally do not wipe a shared inbox.

Configuration: `API_URL` defaults to `http://localhost:8080`; `MAILPIT_URL` defaults to `http://localhost:8025`. Set these to the origin only, without `/api/v1`. For example:

- Compose: expose the API on 8080 and Mailpit on 8025; use the defaults. Start the project's compose stack and migrations first.
- kind and ingress: configure ingress and DNS/hosts for the API, then set `API_URL` to its ingress origin. Port-forward Mailpit to 8025 or set `MAILPIT_URL` to its reachable origin.
- Next proxy: start Next and the API with Mailpit, then set `API_URL=http://localhost:3000`. Ensure the proxy forwards cookies, request IDs, all methods and error headers.

## Important rate-limit constraint

The specification enforces six signups per IP per hour, 20 sign-ins per IP per 15 minutes, and 30 code attempts per IP per 15 minutes. Random emails do **not** isolate these budgets. This comprehensive black-box suite necessarily exceeds them, including with serial execution, and ordinary cases deliberately fail rather than accepting a 429. Run groups in freshly reset disposable environments or with genuinely isolated source IPs and fresh rate-limit state. Do not rely on spoofed forwarding headers: trusted-proxy configuration controls the source IP. Rate-limit tests themselves require clean budgets to verify the exact account thresholds; run them separately against a fresh environment. No test-only bypass is specified by the API. A single uninterrupted run against the default limits cannot pass without infrastructure isolation or a test-specific server configuration.

The security-header test covers available success and client-error paths; there is no specified safe black-box endpoint for inducing a true 500. Fetch rejects newline-containing request headers before transmission; the suite exercises oversized IDs but a raw HTTP/proxy-specific test is needed for newline injection.

## Payments test environment

`payments.test.mjs` needs an API whose Stripe calls go to a local mock. By default it provisions that itself (`lib/payments-env.mjs`) and removes everything in `after()`:

- Creates a database `invigil_payments_e2e_<random>` in the `invigil-postgres-1` container and drops it afterwards. The shared database is not used.
- Starts an API container on the `invigil_default` network from `invigil-rust:dev` (or `PAYMENTS_E2E_IMAGE`), running `cargo run --bin api` from `backend/`. It sets `RUN_MIGRATIONS=true`, `STRIPE_API_BASE=http://127.0.0.1:12111`, and the test-only keys `STRIPE_SECRET_KEY=sk_test_e2e` and `STRIPE_WEBHOOK_SECRET=whsec_e2e`. The first build can take minutes; health and readiness are polled for up to 240 seconds.
- Starts a `node:24-bookworm-slim` sidecar that shares the API's network namespace and runs `lib/stripe-mock.mjs` on `127.0.0.1:12111`. The mock answers only the checkout, billing-portal, payment-intent and subscription reads the API makes.

Requirements: Docker, the compose Postgres container, and the images above. The shared API and its database are not changed. The isolated API does send its mail to the shared Mailpit, and its rate-limit state starts empty.

To test against an API you started yourself, set `PAYMENTS_API_ORIGIN=<origin>` and skip provisioning. That API must have `STRIPE_SECRET_KEY=sk_test_e2e`, `STRIPE_WEBHOOK_SECRET=whsec_e2e`, and a `STRIPE_API_BASE` that is `https`, or plain `http` on `127.0.0.1`, `localhost`, or `[::1]`. The backend rejects other plain-http hosts such as `host.docker.internal`, so a containerised API must reach a loopback mock in its own network namespace (the default path does this). A host-run API can use `STRIPE_MOCK_PORT=<port> node tests/e2e/lib/stripe-mock.mjs` with `STRIPE_API_BASE=http://127.0.0.1:<port>`. The mock's port is `STRIPE_MOCK_PORT` (default 12111).
