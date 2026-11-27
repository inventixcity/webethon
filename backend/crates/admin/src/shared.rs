//! Helpers shared by the admin lists and actions: strict text and id parsing, bounded limits,
//! opaque keyset cursors, the escaped search pattern, and the cached records registry.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{AppError, AppResult, AppState, ErrorCode};
use records::{EntityRegistry, query::escape};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub(crate) const DEFAULT_LIMIT: i64 = 50;
pub(crate) const MAX_LIMIT: i64 = 100;
pub(crate) const MAX_SEARCH_CHARS: usize = 200;
pub(crate) const MAX_ENTITY_CHARS: usize = 64;

pub(crate) fn invalid(path: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":"Invalid value."}]))
}

/// Empty counts as not set, as in the audit log. Control characters and overlong text are refused.
pub(crate) fn text<'a>(
    value: Option<&'a str>,
    path: &str,
    max: usize,
) -> AppResult<Option<&'a str>> {
    match value {
        None | Some("") => Ok(None),
        Some(s) if s.chars().count() > max || s.chars().any(char::is_control) => Err(invalid(path)),
        Some(s) => Ok(Some(s)),
    }
}

/// Empty counts as not set. A value that is not a UUID is refused, with the field named.
pub(crate) fn uuid_filter(value: Option<&str>, path: &str) -> AppResult<Option<Uuid>> {
    match value {
        None | Some("") => Ok(None),
        Some(raw) => Uuid::parse_str(raw).map(Some).map_err(|_| invalid(path)),
    }
}

pub(crate) fn parse_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found())
}

pub(crate) fn bounded_limit(raw: Option<i64>) -> AppResult<i64> {
    let limit = raw.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit"));
    }
    Ok(limit)
}

pub(crate) fn rfc3339(at: OffsetDateTime) -> AppResult<String> {
    at.format(&Rfc3339).map_err(AppError::internal)
}

/// A substring pattern for `ilike ... escape '\'`. `%`, `_` and `\` in the search are literal.
pub(crate) fn like_pattern(search: &str) -> String {
    format!("%{}%", escape(search))
}

/// Position in a list: the last row returned, ordered by `(at, id)` descending. Opaque to clients.
#[derive(Clone, Copy)]
pub(crate) struct Cursor {
    pub(crate) at: OffsetDateTime,
    pub(crate) id: Uuid,
}

fn bad_cursor() -> AppError {
    invalid("cursor")
}

pub(crate) fn encode_cursor(at: OffsetDateTime, id: Uuid) -> AppResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(format!("{}|{id}", rfc3339(at)?)))
}

pub(crate) fn decode_cursor(raw: &str) -> AppResult<Cursor> {
    if raw.len() > 128 {
        return Err(bad_cursor());
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| bad_cursor())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| bad_cursor())?;
    let (at, id) = text.split_once('|').ok_or_else(bad_cursor)?;
    Ok(Cursor {
        at: OffsetDateTime::parse(at, &Rfc3339).map_err(|_| bad_cursor())?,
        id: Uuid::parse_str(id).map_err(|_| bad_cursor())?,
    })
}

/// An empty cursor means the first page.
pub(crate) fn optional_cursor(raw: Option<&str>) -> AppResult<Option<Cursor>> {
    match raw {
        None | Some("") => Ok(None),
        Some(raw) => Ok(Some(decode_cursor(raw)?)),
    }
}

// ----------------------------------------------------------------------------------------------
// Registry

type RegistryCache = Mutex<HashMap<String, Arc<EntityRegistry>>>;
static REGISTRIES: OnceLock<RegistryCache> = OnceLock::new();

/// The admin router sits outside the records router's registry extension, so it loads the same
/// file itself. The result is cached per path, so each request does not re-read and re-compile
/// every entity's JSON schema.
pub(crate) fn load_registry_cached(state: &AppState) -> AppResult<Arc<EntityRegistry>> {
    let path = &state.config.entities_path;
    let cache = REGISTRIES.get_or_init(|| Mutex::new(HashMap::new()));
    // A panic while the lock was held cannot leave the map half-written, so reuse it after poison.
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(found) = cache.get(path) {
        return Ok(found.clone());
    }
    let loaded = Arc::new(records::load_registry(path).map_err(AppError::internal)?);
    cache.insert(path.clone(), loaded.clone());
    Ok(loaded)
}

/// Unknown entity names are 404, the same as an unknown record id. Callers check the entity
/// before parsing the id, so an unknown entity is 404 whatever the id looks like.
pub(crate) fn known_entity(state: &AppState, entity: &str) -> AppResult<()> {
    let registry = load_registry_cached(state)?;
    registry.definition(entity)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let id = Uuid::new_v4();
        let at = OffsetDateTime::UNIX_EPOCH + time::Duration::seconds(1_700_000_000);
        let raw = encode_cursor(at, id).unwrap();
        let back = decode_cursor(&raw).unwrap();
        assert_eq!(back.at, at);
        assert_eq!(back.id, id);
        assert!(decode_cursor("not base64 !!").is_err());
        assert!(decode_cursor(&URL_SAFE_NO_PAD.encode("no-separator")).is_err());
        assert!(decode_cursor(&"a".repeat(129)).is_err());
        assert!(optional_cursor(Some("")).unwrap().is_none());
    }

    #[test]
    fn like_pattern_escapes_wildcards_and_backslash() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b\\c"), "%a\\_b\\\\c%");
    }

    #[test]
    fn text_and_limit_are_strict() {
        assert!(text(Some("a\nb"), "q", 10).is_err());
        assert!(text(Some("abcd"), "q", 3).is_err());
        assert_eq!(text(Some(""), "q", 3).unwrap(), None);
        assert!(bounded_limit(Some(0)).is_err());
        assert!(bounded_limit(Some(101)).is_err());
        assert_eq!(bounded_limit(None).unwrap(), DEFAULT_LIMIT);
    }

    #[test]
    fn uuid_filter_treats_empty_as_unset() {
        assert_eq!(uuid_filter(Some(""), "ownerId").unwrap(), None);
        assert!(uuid_filter(Some("nope"), "ownerId").is_err());
    }
}
