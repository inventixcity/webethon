//! Converts between `time` (what sqlx and the JSON use) and `chrono` (what the time-zone rules use).

use chrono::{DateTime, Utc};
use kernel::{AppError, AppResult};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

pub fn to_chrono(at: OffsetDateTime) -> AppResult<DateTime<Utc>> {
    DateTime::from_timestamp(at.unix_timestamp(), at.nanosecond())
        .ok_or_else(|| AppError::internal("timestamp out of range"))
}

pub fn from_chrono(at: DateTime<Utc>) -> AppResult<OffsetDateTime> {
    let whole = OffsetDateTime::from_unix_timestamp(at.timestamp()).map_err(AppError::internal)?;
    Ok(whole + time::Duration::nanoseconds(i64::from(at.timestamp_subsec_nanos())))
}

/// RFC 3339 in UTC, e.g. `2030-03-31T08:00:00Z`.
pub fn rfc3339(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Parses an RFC 3339 instant. An offset is required, so a bare local time is rejected.
pub fn parse_instant(raw: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(raw, &Rfc3339)
        .ok()
        .map(|at| at.to_offset(UtcOffset::UTC))
}

pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// RFC 3339 in UTC from a chrono instant, e.g. `2030-03-31T08:00:00Z`.
pub fn utc_string(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
