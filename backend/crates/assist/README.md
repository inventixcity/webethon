# Assist

Authenticated routes are mounted beneath `/api/v1`. `POST /assist/ask` accepts `{ "question": "...", "entity": "notes" }` (entity optional) and streams SSE `delta`, `sources`, `pending`, `done`, or `error` events. The assistant may search and read only the viewer's own records, and can propose up to five actions per request. Proposed writes expire after ten minutes and do not mutate records. `POST /assist/confirm` accepts `{ "actionId": "uuid" }` and returns `{ "data": { "record": ... } }`; a claim and the record mutation commit together. `POST /assist/cancel` takes the same body and returns 204. Actions are owner-bound and single-use. `POST /assist/search` accepts `{ "entity": "notes", "query": "...", "limit": 10 }` and returns `{ "data": [{ "record": ..., "score": 1.0 }] }`; the score denotes cosine similarity when embeddings are configured, or a lexical match otherwise.

The model uses the shared AI configuration and quota, charging each provider round. Record contents are untrusted data and never authorize writes.

Semantic search uses `AI_API_KEY` and `AI_EMBEDDING_MODEL` with the shared `AI_BASE_URL`. When either is missing, search uses lexical matches and returns score 1.0. When both are configured, provider failures return 503 and search ranks only already-embedded records by cosine similarity (higher is closer); records awaiting embeddings are omitted until processed. Embedding requests use the same per-user AI allowance as chat. Only configured searchable fields are sent to the provider.

The host must call `assist::spawn_worker(state.clone())` at startup; an authenticated assist search or ask also starts a worker as a fallback. The database queue retains jobs across restarts and uses leases for recovery. Postgres must have the pgvector extension available.

Embedding vectors are limited to 16,000 dimensions; configure a model that fits this limit.
