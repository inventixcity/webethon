# AI API

`ai::router() -> Router<AppState>` provides these authenticated routes, relative to `/api/v1`:

- `POST /ai/chat`: `{ messages: [{ role: "user" | "assistant", content }], model? }`. Streams SSE `delta`, then `done` or `error`. Headers disable caching and proxy buffering.
- `POST /ai/complete`: `{ prompt, json?: bool }`. Returns `{ data: { text, usage: { input, output }, json? } }`. JSON mode requires a JSON object; unreadable output returns HTTP 502 with `UNAVAILABLE`.
- `GET /ai/usage`: `{ data: { day, requests, inputTokens, outputTokens, dailyLimit } }`, including reservations for in-flight requests. Days are UTC.

No integration edits are included. Apply `migrations/20261122000400_ai.sql` and mount the router in the server. The server/proxy timeout must allow `AI_TIMEOUT_SECS` (the documented server default is only 15 seconds), and the proxy must stream responses and propagate disconnects.

## Configuration

Read once, on first use, through `OnceLock`; restart to apply changes. Credentials are never exposed by the API.

| Variable | Default | Behavior |
| --- | --- | --- |
| `AI_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | HTTP(S) base URL; `/chat/completions` is appended. |
| `AI_API_KEY` | none | Required. |
| AI_MODEL | none | Required default model, at most 256 bytes. |
| AI_EMBEDDING_MODEL | none | Optional embedding model; absence does not affect chat readiness. |
| `AI_MODELS_ALLOWED` | empty | Comma-separated explicit choices for `/chat`; no client choice unless listed. |
| `AI_SYSTEM_PROMPT` | `You are a helpful assistant.` | Server-only system message, at most 192000 bytes. |
| `AI_MAX_OUTPUT_TOKENS` | `1024` | Positive integer; clamped to 4096. |
| `AI_DAILY_TOKENS_PER_USER` | `200000` | Positive integer; clamped to a safe bigint range. |
| `AI_TIMEOUT_SECS` | `60` | Positive integer; clamped to 3600 seconds. Covers upstream headers and streaming body. |

Missing credentials/model or invalid numeric/base URL configuration returns `NOT_CONFIGURED` (503), without panicking. All request fields reject unknown keys. Validation counts Unicode characters. Chat permits 1..40 messages, 1..8000 characters each, and 48000 total; completion permits 1..16000 characters. Client `system` roles are rejected. Model strings are bounded to 256 characters and checked against the allow list.

Both generation routes use the shared reqwest client with SSE streaming and `include_usage: true`. The SSE decoder handles split lines, UTF-8 split across chunks, CRLF, comments, multiline data, upstream error objects, usage-only chunks and `[DONE]`. Upstream responses are bounded to 2 MiB. Missing `[DONE]` is an error. Upstream text, prompts, completions, keys and reqwest diagnostics are never logged. Logs contain model, latency and token counts; `ai.request` audit metadata contains only token counts.

## Accounting and cancellation

Generation is limited to 20 attempts per minute per user through the shared Postgres rate limiter. Admission atomically reserves `ceil(all server/client message characters / 3) + max_output_tokens`. The first insert checks the limit, as does every conflict update. Rejected reservations do not increment daily requests.

A completed response replaces its reservation with actual upstream usage. If usage is absent, the full estimate remains charged, including on upstream errors or disconnects. Observed usage is retained if a stream later fails. The original UTC day is fixed in the reservation so requests spanning midnight settle correctly. Requests count admitted attempts, including upstream errors.

Reservation creation runs in an owned task so cancellation while Postgres commits cannot leave an unowned reservation. A drop guard initiates settlement and audit on handler/stream cancellation. Settlement itself runs in an owned task so cancellation during its database write cannot interrupt accounting. The bounded streaming worker selects on downstream channel closure, interrupting an upstream read or backpressured send and dropping the reqwest body before settlement.

The daily limit is an admission limit based on the specified estimate, not an exact provider billing ceiling. Actual provider usage can exceed the estimate and push the corrected row above the limit; subsequent requests are refused. Exact billing ceilings would require a guaranteed token upper bound or provider-side budgets. Unavailable databases or process termination leave conservative reservations in place; settlement failures are logged, and no persistent retry queue is implemented.

## Validation report

Passed through `backend/scripts/cargo.sh` with Postgres running:

- `fmt -p ai` and `fmt -p ai -- --check`
- `check -p ai`
- `clippy -p ai --all-targets -- -D warnings`
- `test -p ai`: **20 passed, 0 failed** (4 unit, 16 sqlx database tests); 0 doctests.

Coverage includes streaming order and split chunks, validation/authentication, shared rate limiting, ten concurrent reservations, first-insert budget enforcement, provider status mapping and Retry-After, unreadable JSON, missing configuration, disconnect cancellation with/without usage, cancellation while a reservation waits on a row lock, UTC rollover settlement, timeout/error sanitization, truncation detection and audit privacy.

Files: this README, `Cargo.toml`, `src/{lib,config,metering,upstream,tests}.rs`, and the AI migration. All dependencies already exist in workspace dependencies. This crate enables reqwest's `stream` and tower's test-only `util` features locally. No root manifest additions, kernel changes, server/proxy edits, or commits. Cargo may refresh the shared lockfile when resolving the crate dependencies; the manager owns lockfile integration.

## Shared Rust interface

`ai::config::global()` returns the shared `Arc<AiConfig>`, initialized once from the environment. `AiConfig` exposes its configuration fields, including optional `embedding_model` and the secrecy-wrapped `key`; `ready()` checks chat configuration. Callers constructing a config directly must set `valid` to reflect their configuration validation.

`ai::metering::{Reservation, Usage}` provides the same per-user daily allowance and rate limit as chat. Call `Reservation::reserve(&db, user_id, meta, estimated_input, &config, model).await` once per upstream request. It reserves the input estimate and `config.max_output`. Set observed `Usage { input, output }` with `set_usage`, then call `finish().await`; dropping a reservation also schedules settlement. If usage is unavailable, leave the conservative reservation in place. The original reservation day is used for settlement across midnight.