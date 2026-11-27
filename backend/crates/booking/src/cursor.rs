//! Opaque keyset cursors for lists. A cursor records the sort key of the last row returned,
//! plus the list it belongs to, so it can't be replayed against a different list.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::clock;

pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 100;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    /// Sort key as RFC 3339.
    t: String,
    id: Uuid,
    /// Which list this cursor belongs to.
    k: String,
}

pub fn encode(kind: &str, at: OffsetDateTime, id: Uuid) -> AppResult<String> {
    let raw = Raw {
        t: clock::rfc3339(at),
        id,
        k: kind.to_owned(),
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&raw).map_err(AppError::internal)?))
}

pub fn decode(cursor: &str, kind: &str) -> AppResult<(OffsetDateTime, Uuid)> {
    let invalid = || crate::validate::invalid("cursor", "Please provide a valid cursor.");
    if cursor.len() > 1024 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
    let raw: Raw = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if raw.k != kind {
        return Err(invalid());
    }
    let at = clock::parse_instant(&raw.t).ok_or_else(invalid)?;
    Ok((at, raw.id))
}

pub fn page_limit(raw: Option<i64>) -> AppResult<i64> {
    match raw {
        None => Ok(DEFAULT_LIMIT),
        Some(limit) if (1..=MAX_LIMIT).contains(&limit) => Ok(limit),
        Some(_) => Err(crate::validate::invalid(
            "limit",
            "Use a limit from 1 to 100.",
        )),
    }
}

/// Trims a page fetched with one extra row. Returns the cursor for the next page, if there is one.
pub fn trim_page<T>(
    rows: &mut Vec<T>,
    limit: i64,
    cursor_of: impl Fn(&T) -> AppResult<String>,
) -> AppResult<Option<String>> {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    if rows.len() <= limit {
        return Ok(None);
    }
    rows.truncate(limit);
    match rows.last() {
        Some(last) => cursor_of(last).map(Some),
        None => Ok(None),
    }
}
