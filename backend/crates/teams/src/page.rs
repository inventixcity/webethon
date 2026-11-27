//! Keyset pagination for member lists. A cursor is the last row's (joined_at, user id), so pages stay
//! stable when people join or leave between requests, and the database never scans past the page.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 100;
/// Cursors are short. Anything longer is junk, so refuse it before decoding.
const MAX_CURSOR_CHARS: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub struct Page {
    pub limit: i64,
    pub after: Option<(OffsetDateTime, Uuid)>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    t: String,
    id: Uuid,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

fn invalid(path: &str, message: &str) -> AppError {
    crate::input::failure(path, message)
}

pub fn parse(query: PageQuery) -> AppResult<Page> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit", "Choose a limit between 1 and 100."));
    }
    let after = query.cursor.as_deref().map(decode).transpose()?;
    Ok(Page { limit, after })
}

pub fn encode(joined_at: OffsetDateTime, user_id: Uuid) -> AppResult<String> {
    let cursor = Cursor {
        t: joined_at.format(&Rfc3339).map_err(AppError::internal)?,
        id: user_id,
    };
    let bytes = serde_json::to_vec(&cursor).map_err(AppError::internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode(raw: &str) -> AppResult<(OffsetDateTime, Uuid)> {
    if raw.is_empty() || raw.len() > MAX_CURSOR_CHARS {
        return Err(invalid("cursor", "Enter a valid cursor."));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| invalid("cursor", "Enter a valid cursor."))?;
    let cursor: Cursor =
        serde_json::from_slice(&bytes).map_err(|_| invalid("cursor", "Enter a valid cursor."))?;
    let at = OffsetDateTime::parse(&cursor.t, &Rfc3339)
        .map_err(|_| invalid("cursor", "Enter a valid cursor."))?;
    Ok((at, cursor.id))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn pagination_validation_and_round_trip() {
        assert_eq!(parse(PageQuery::default()).unwrap().limit, DEFAULT_LIMIT);
        let at = OffsetDateTime::now_utc();
        let id = Uuid::new_v4();
        let cursor = encode(at, id).unwrap();
        assert_eq!(
            parse(PageQuery {
                limit: Some(5),
                cursor: Some(cursor)
            })
            .unwrap()
            .after,
            Some((at, id))
        );
        for limit in [0, 101, -1] {
            assert!(
                parse(PageQuery {
                    limit: Some(limit),
                    cursor: None
                })
                .is_err()
            );
        }
        for cursor in [
            String::new(),
            "!!!".to_owned(),
            "a".repeat(MAX_CURSOR_CHARS + 1),
        ] {
            assert!(
                parse(PageQuery {
                    limit: None,
                    cursor: Some(cursor)
                })
                .is_err()
            );
        }
    }
}
