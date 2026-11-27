# Social API (round 1)

All routes are under `/api/v1`. Record routes require a readable, live record and the corresponding social feature enabled. Mutations require sign-in. Comments list returns `{data:[{id,entity,recordId,authorId,parentId,body,createdAt,updatedAt,deletedAt}]}`; deleted comments have `body: null` and remain as thread placeholders. Replies to deleted parents are rejected. POST comments accepts `{body,parentId?}` and returns 201 `{data:comment}`; PATCH `/comments/{id}` accepts `{body}` and returns `{data:comment}`; DELETE returns 204. Only authors can edit/delete, and a reply cannot itself have replies.

Reactions GET returns `{data:{counts:{kind:count},mine:[kind]}}`; PUT/DELETE `/entities/{entity}/{id}/reactions/{kind}` return 204. Bookmark GET returns `{data:{active:boolean}}` and PUT/DELETE return 204. Follow GET `/users/{id}/follow` returns `{data:{active:boolean}}`; PUT/DELETE return 204. GET `/bookmarks?limit=20&cursor=<uuid>` returns `{data:[record],meta:{nextCursor}}`, checking current access and feature configuration for every record.

The migration defines `social_comments`, `social_reactions`, `social_bookmarks`, `social_follows`, `social_notifications`, and `social_activity`. Notifications hold recipient, kind, actor, optional entity/record/comment references, read and creation timestamps. Activity holds actor, kind, optional target user or record references and creation time, without record data or comment text. Notification insertion emits transactional `social_notifications` PostgreSQL NOTIFY JSON containing only `recipientId` and `notificationId`. Consumers must recheck actor, target, record access, and feature settings at read/delivery time. 

## Notifications and activity

GET `/notifications?limit=20&cursor=<uuid>` returns `{data:[{id,kind,actor:{id,displayName},entity,recordId,commentId,readAt,createdAt}],meta:{nextCursor,unreadCount}}`. GET `/notifications/count` returns `{data:{unreadCount}}`. POST `/notifications/read` accepts exactly one of `{ids:[uuid,...]}` (at most 100) or `{all:true}` and returns 204. Unknown or inaccessible IDs are ignored. GET `/activity?limit=20&cursor=<uuid>` returns `{data:[{id,kind,actor:{id,displayName},targetUserId,entity,recordId,commentId,createdAt}],meta:{nextCursor}}`. Limits are 1–100; cursors are opaque UUIDs from the prior page. Dates are RFC 3339 strings; optional references and `readAt` can be null. All results reflect current access and settings.


GET `/notifications/events` requires a signed-in session and returns an SSE stream. It sends `resync` with `{}` on connection, listener reconnect, or buffer lag; fetch the notification list after each resync. A `notification` event contains `{ "notification": <notification> }` in the same shape as the list. Heartbeat comments are sent every 15 seconds. There is no durable replay or Last-Event-ID support. Visibility, account status, role and session validity are checked again at delivery; invalid sessions close the stream.

A process starts a shared PostgreSQL listener lazily for each database connection identity when its first stream opens. It stops after the last stream closes; listener failures retry with backoff and trigger resync. The hub holds only recipient and notification IDs, with a 256-item broadcast buffer, at most 1,024 streams per database, four per user, and 64 active database hubs per process. A lagging client receives resync; clients should reconnect if the connection closes. Stream limits apply independently in each API process.

Reaction events are visible only while their specific reaction kind remains enabled in the current entity configuration. Legacy reaction events without a recorded kind stay hidden; re-enabling a recorded kind makes its events visible again if access still permits it.

Reaction notifications and activity retain the reaction kind internally. If a kind is removed from an entity's configuration, its existing events disappear from notifications, unread counts, streams, and activity; legacy reaction events without a recorded kind are hidden as well.

Team records are available only to current members of a live team. Team viewers may comment, react, and bookmark because these actions require record read access; editing a record has separate permissions. Comment edits and deletions remain author-only, including for team administrators. Team activity never appears in the public feed. Notifications require both actor and recipient to remain team members.

Moderator-hidden comments remain thread placeholders with a null body for everyone on ordinary routes. Authors can delete them but cannot edit them, and replies to them are rejected. Their notifications and activity are hidden. Hidden personal records are visible only to their owner or a global admin; public activity excludes them, and notifications require both parties to retain access.

Moderator tools are plain functions in `social::moderation` with no HTTP route. `set_comment_admin_hidden` must run in the caller's transaction, and `list_comments`/`get_comment` return bodies of hidden comments for moderation only.
