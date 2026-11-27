# Records phase 2 facade

`records::registry` exposes `EntityRegistry::from_json(&str)`, `definition(&str)`, the definition and access types, and `SocialConfig`. Missing social configuration is `None` and means all social features are disabled. Present settings default to disabled. Reaction names are unique, 1–32 ASCII lowercase letters, digits, underscores or hyphens, with at most 16 kinds.

`EntityRegistry::definitions()` iterates over borrowed entity names and definitions in ascending name order, for trusted consumers that need registry metadata.

`records::query::{ListQuery, parse}` and `records::service::{Record, get}` are public; `Record::readable` and `Record::writable` perform the existing access checks.

`records::api::read(state, registry, viewer: Option<&Viewer>, entity, id)`, `create(state, registry, viewer, meta, entity, data, visibility: Option<&str>)`, and `update(state, registry, viewer, meta, entity, id, data, version)` return raw record JSON. They share the HTTP handler paths, including access, defaults, schema validation, owner caps, auditing, and optimistic version checks. Update merges object fields as PATCH does; it does not alter visibility. These functions commit their own mutations. `create_in_tx(tx, registry, viewer, meta, entity, data, visibility)` and `update_in_tx(tx, registry, viewer, meta, entity, id, data, version)` use the same checks and return raw record JSON, but leave commit or rollback to the caller; their audit entries are in that transaction. The caller must separately enforce any narrower ownership policy.
