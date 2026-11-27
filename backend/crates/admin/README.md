# Admin foundation

All routes require a signed-in administrator. `POST /api/v1/admin/step-up` accepts `{password, code?}` and returns `{data:{expiresAt}}`. An enabled TOTP factor requires a fresh six-digit authenticator code. Missing or stale step-up returns HTTP 428 `PRECONDITION_REQUIRED` with `details.reason = "STEP_UP_REQUIRED"`.

`GET /api/v1/admin/overview` and `/stats` return `{data:{users, activeSessions, signupsPerDay, aiUsage, revenue, auditEvents, httpErrorRate, http429Rate}}`. Revenue is gross recorded purchases grouped by currency, not net revenue. HTTP rates are null because the database does not store HTTP outcomes. `GET /api/v1/admin/system` returns `{data:{database, appliedMigrations, config, rateLimits}}`; rate-limit keys are never returned.

Future mutations must call `security::require_step_up` inside their transaction, `security::reject_self` for role/status/MFA actions, and `audit::audit_before_after` before commit. Helpers are crate-private for subsequent admin rounds. No impersonation route is provided.

## User administration

`GET /users` accepts `q`, `role` (`user` or `admin`), `status` (`active`, `suspended`, or `deleted`), `verified`, `mfa`, `sort` (`newest` or `oldest`), `limit` (1�100), and a UUID `cursor`; it returns `{data:[...],meta:{nextCursor}}`. Search is literal and case-insensitive. `GET /users/{id}` returns `{data:{user,sessions,audit,teams,files,entitlements}}`; each child collection is limited to 50, and sessions contain metadata only.

`POST /users/{id}/suspend`, `/unsuspend`, `/role` (`{role}`), `/sessions/revoke`, `/mfa/reset`, `/delete`, and `/restore` require step-up and return 204. Self actions are rejected. Admin role cannot be granted to an unverified account; configured administrators cannot be demoted through this API. Suspension, deletion, session revocation and MFA reset revoke sessions; restoration does not reinstate them.

`POST /users/{id}/verification/resend` requires step-up and returns 202. For an unverified account it emails a signup restart link, so the email owner chooses a fresh password and completes the pending-signup flow. It never verifies the old account or sends a code bound to its existing password. For an already verified account it is a no-op. Email delivery happens after the audit transaction commits; an email delivery failure does not roll back the audit.

## Audit log

Both routes require an administrator: a non-admin gets 403 and an anonymous caller gets 401. Neither route needs step-up, because neither changes anything.

`GET /api/v1/admin/audit` accepts `actor` (user UUID), `action` (exact match, max 64 characters), `target` (exact `targetId`, max 128 characters), `from` and `to` (RFC 3339, inclusive, for example `2026-11-01T00:00:00Z`), `limit` (1-100, default 50) and an opaque `cursor`. An empty value counts as not set. Rows are newest first, sorted by `at desc, id desc`. It returns `{data:[{id, at, actorId, action, targetType, targetId, ip, userAgent, requestId, meta}], meta:{nextCursor}}`. `nextCursor` is null on the last page. Keys that look like secrets (password, secret, token, hash, code, cookie, credential, authorization, nonce) are removed from `meta` at any depth, so rows written by older code are redacted too.

`GET /api/v1/admin/audit/export` streams `text/csv; charset=utf-8` with the same filters. The first line is the header `id,at,actorId,action,targetType,targetId,ip,userAgent,requestId,meta`, and lines end in CRLF. A result over 50,000 rows returns 400 `VALIDATION_FAILED` and writes nothing, so narrow the filters. Each cell that starts with `=`, `+`, `-`, `@`, tab or CR gets a leading apostrophe, and cells containing commas, quotes or newlines are quoted (RFC 4180). The budget is 10 exports per user per 10 minutes; beyond that the response is 429 `RATE_LIMITED`. Each export writes an `admin.audit.export` row whose `before.filters` holds the filters and whose `after.rows` holds the count. The row never holds exported rows. The file is a snapshot taken before that row is written, so the export does not contain itself.

Errors on both routes: an unknown parameter, a `limit` outside 1-100, a malformed UUID or timestamp, `from` after `to`, or a bad cursor returns 400 `VALIDATION_FAILED` with `details[{path}]`.

## Content moderation

Every route requires an administrator: a non-admin gets 403 and an anonymous caller gets 401. Entity names come only from the records registry (`ENTITIES_PATH`), and they are bound as values, never spliced into SQL. Ids are UUIDs; a malformed id is 400. An unknown entity is 404 whatever the id looks like.

`GET /api/v1/admin/content` lists rows of one entity across personal and team records, hidden and deleted included. Query parameters:

- `entity` (required, up to 64 characters). Missing or empty → 400. A name that is not in the registry → 404.
- `q` (optional, up to 200 characters, no control characters). A case-insensitive substring match over the entity's `searchable` fields, the same match as the records list. The search is literal: `%`, `_` and `` match themselves. An entity with no searchable fields → 400.
- `visibility`: `public` (public rows), `private` (personal private rows, team rows excluded), or `team` (rows with a `teamId`). Any other value → 400. Team rows are always private in the database, so they only match `team`.
- `deleted` (boolean, default `false`): live rows only. `true` returns deleted rows only.
- `hidden` (boolean, optional): omitted means both. `true` returns hidden rows only, `false` returns visible rows only.
- `limit` (1-100, default 50) and `cursor` (opaque; take it from `meta.nextCursor`). A bad limit or cursor → 400.

Rows are newest first, sorted by `createdAt desc, id desc`. The response is `{data:[row,...], meta:{nextCursor}}`, and `nextCursor` is null on the last page. A row holds no record data:

`{id, entity, ownerId, teamId, visibility, moderationHidden, deleted, version, createdAt, updatedAt}`

`GET /api/v1/admin/content/{entity}/{id}` returns `{data:{...row, data, history}}`. `data` is the record's JSON as stored. It is the content under review, so it is not key-redacted. `history` is the newest 50 audit rows whose target is this record, sorted by `at desc, id desc`. Each entry is `{id, at, actorId, action, meta}`, and secret-looking keys are removed from `meta`. Unknown entity or record → 404.

`POST /api/v1/admin/content/{entity}/{id}/hide`, `/unhide`, `/delete` and `/restore` take no body and return 204. Each one:

- requires a fresh step-up, checked inside the transaction. A missing or stale step-up returns 428 `PRECONDITION_REQUIRED` with `details.reason = "STEP_UP_REQUIRED"`;
- uses the same write budget as the user actions, per IP and per administrator, and returns 429 `RATE_LIMITED` when it is spent;
- locks the administrator and the record's owner in id order, then the record row, so it cannot race an account change;
- calls the records functions `set_admin_hidden`, `admin_soft_delete` or `admin_restore`, so the records rules apply. Team rows can be moderated through this path only. Hide and unhide never change data or visibility. A hide of an already hidden record changes nothing and does not bump `version`.
- writes one audit row in the same transaction, before commit. Its action is `admin.content.hide`, `admin.content.unhide`, `admin.content.delete` or `admin.content.restore`, its target is `record` with the record id, and its meta is `{before:{version,moderationHidden,deleted}, after:{...}}`. The row never holds record data.

Hide and unhide are refused on a deleted record, and delete and restore are refused in the wrong state. Those refusals return 404 and write no audit row. A missing or stale step-up is refused before anything changes.

Errors on these routes: 400 `VALIDATION_FAILED` with `details[{path}]` for an unknown or malformed query parameter, a bad limit, cursor, id or `q`; 404 `NOT_FOUND` for an unknown entity or record; 403, 401, 428 and 429 as above. A list with a `q` longer than 200 characters returns 400 `VALIDATION_FAILED` on `q`.

## Files

Every route requires an administrator: a non-admin gets 403 and an anonymous caller gets 401. Ids are UUIDs; a malformed id is 400 and an unknown file is 404.

`GET /api/v1/admin/files` lists uploaded files, newest first (`createdAt desc, id desc`). Query parameters:

- `ownerId` (UUID). Empty means not set. Anything else that is not a UUID is 400.
- `deleted` (boolean, default `false`): live files only. `true` returns deleted files only.
- `q` (up to 200 characters, no control characters): a case-insensitive substring match on the file name only. `%`, `_` and `\` are literal. A file with no name never matches.
- `limit` (1-100, default 50) and `cursor` (opaque; take it from `meta.nextCursor`).

Each row is `{id, ownerId, name, contentType, size, createdAt, deletedAt}`, and nothing else. A storage key, a path, a URL, a checksum or a preview is never returned. The response is `{data:[row,...], meta:{nextCursor}}`, and `nextCursor` is null on the last page.

`GET /api/v1/admin/files/{id}` returns `{data:{...row, history}}`. Deleted files are shown too. `history` is the newest 50 audit rows for this file, newest first, with secret-looking keys removed from `meta`.

`DELETE /api/v1/admin/files/{id}` returns 204 and works like the other mutations:

- It requires a fresh step-up, checked inside the transaction. A missing or stale step-up returns 428 `PRECONDITION_REQUIRED` with `details.reason = "STEP_UP_REQUIRED"`, and nothing changes.
- It uses the same write budget as the content actions, per IP and per administrator, and returns 429 when it is spent.
- It locks the administrator and the file's owner in id order, then the file row.
- It sets `deleted_at`, the same column the owner's delete uses. The row is kept.
- It writes `admin.files.delete` in the same transaction. `before` and `after` hold only `ownerId`, `sizeBytes` and `deleted`.
- A file that is missing or already deleted returns 404 and writes no audit row.

Byte cleanup happens after the commit. The server's storage removes the object, using the key from the database row. The key is never returned and never logged. The purge is best effort. If it fails, the reply is still 204, because the file is already gone from every list. The log names only the file id. The bytes then stay in storage. There is no retry job yet, so those bytes need a later cleanup pass.

Errors: 400 `VALIDATION_FAILED` with `details[{path}]` for an unknown or malformed parameter, a bad limit, cursor, id or `q`.

## Comments

Every route requires an administrator, with the same 403, 401, 428 and 429 behaviour as above. Ids are UUIDs.

`GET /api/v1/admin/comments` lists social comments, newest first (`createdAt desc, id desc`). Query parameters:

- `q` (up to 200 characters, no control characters): a case-insensitive substring match on the comment body. `%`, `_` and `\` are literal. Only a body that is shown can match. An author-deleted comment that is not hidden shows a placeholder, so its text is not searchable either.
- `entity` (a name from the registry). An unknown name is 400 here, not 404, because it is a filter.
- `recordId` (UUID).
- `hidden` (boolean): `true` returns hidden comments only, `false` returns visible ones only, and omitted returns both.
- `deleted` (boolean, default `false`): live comments only. `true` returns deleted comments only.
- `limit` (1-100, default 50) and `cursor` (opaque; take it from `meta.nextCursor`).

Each row is `{id, entity, recordId, authorId, parentId, body, hidden, hiddenAt, createdAt, updatedAt, deletedAt}`.

**This is the only admin route that returns a comment body, and it is for moderation.** A hidden comment's body is returned here so a moderator can review it. An author-deleted comment that is not hidden returns `body: null`, the same placeholder the public sees. The ordinary social comment reads return `body: null` for hidden and deleted comments. Do not reuse this response in any other route.

`POST /api/v1/admin/comments/{id}/hide` and `/unhide` return 204. Both need a fresh step-up, and both write `admin.comments.hide` or `admin.comments.unhide` with `before` and `after` holding `hidden` and `deleted` only. Hiding is idempotent and keeps the first hide time. These two actions also work on a deleted comment.

`POST /api/v1/admin/comments/{id}/delete` returns 204. It is a soft delete: it sets `deleted_at` and `updated_at` on the social row, and the row is kept. It writes `admin.comments.delete` with the same before and after flags. A comment that is missing or already deleted returns 404 and writes no audit row.

Pending: there is no admin restore route for comments yet. The comment list SQL and the soft delete live in this crate, because `social::moderation::list_comments` has no `q` filter, and social has no admin soft delete function.
