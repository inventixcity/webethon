//! Read side of the audit log: a filtered, keyset-paged list and a streamed CSV export.
//! Mutation paths write the rows (see `audit.rs`). This module only reads them, plus one row that
//! records each export, written without the exported rows.

use crate::{AdminViewer, audit};
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures::stream;
use kernel::extract::Query;
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    request::RequestMeta,
    security::{Limit, enforce_rate_limit},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{io, time::Duration};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
/// The export refuses a larger result instead of cutting it short, so nobody gets a quietly
/// incomplete file. Narrow the filters to export the rest.
pub(crate) const MAX_EXPORT_ROWS: i64 = 50_000;
/// Rows read per database round trip while the export streams.
const EXPORT_PAGE_ROWS: i64 = 500;
/// Exports read a lot, so they get a small budget of their own.
const EXPORT_BUDGET: Limit = Limit {
    limit: 10,
    window: Duration::from_secs(10 * 60),
};
const CSV_HEADER: &str = "id,at,actorId,action,targetType,targetId,ip,userAgent,requestId,meta\r\n";

// Filters are bound by position. A null bind turns its filter off. Every SQL identifier here is
// fixed in the source, so no request text ever becomes SQL.
// $6 is a snapshot ceiling. The export sets it to the newest id before it writes its own audit
// row, so that row (and anything written during the download) is not part of the file.
const LIST_SQL: &str = "select id,at,actor_id,action,target_type,target_id,ip,user_agent,request_id,meta from audit_log \
    where ($1::uuid is null or actor_id=$1) \
    and ($2::text is null or action=$2) \
    and ($3::text is null or target_id=$3) \
    and ($4::timestamptz is null or at>=$4) \
    and ($5::timestamptz is null or at<=$5) \
    and ($6::bigint is null or id<=$6) \
    and ($7::timestamptz is null or (at,id)<($7,$8::bigint)) \
    order by at desc,id desc limit $9";
const COUNT_SQL: &str = "select count(*) from (select 1 from audit_log \
    where ($1::uuid is null or actor_id=$1) \
    and ($2::text is null or action=$2) \
    and ($3::text is null or target_id=$3) \
    and ($4::timestamptz is null or at>=$4) \
    and ($5::timestamptz is null or at<=$5) \
    and ($6::bigint is null or id<=$6) limit $7) counted";

fn invalid(path: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":"Invalid value."}]))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct AuditQuery {
    actor: Option<String>,
    action: Option<String>,
    target: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

/// Validated filters. An empty query value counts as "not set".
pub(crate) struct Filters {
    actor: Option<Uuid>,
    action: Option<String>,
    target: Option<String>,
    from: Option<OffsetDateTime>,
    to: Option<OffsetDateTime>,
}

impl Filters {
    /// Values only, never SQL. Safe to store in the export's audit row.
    fn describe(&self) -> Value {
        json!({
            "actor": self.actor.map(|u| u.to_string()),
            "action": self.action.as_deref(),
            "target": self.target.as_deref(),
            "from": self.from.map(rfc3339),
            "to": self.to.map(rfc3339),
        })
    }
}

fn parse_filters(q: &AuditQuery) -> AppResult<Filters> {
    let actor = text(q.actor.as_deref(), "actor", 64)?
        .map(|s| Uuid::parse_str(s).map_err(|_| invalid("actor")))
        .transpose()?;
    let action = text(q.action.as_deref(), "action", 64)?.map(str::to_owned);
    let target = text(q.target.as_deref(), "target", 128)?.map(str::to_owned);
    let from = time_param(q.from.as_deref(), "from")?;
    let to = time_param(q.to.as_deref(), "to")?;
    if let (Some(from), Some(to)) = (from, to)
        && from > to
    {
        return Err(invalid("to"));
    }
    Ok(Filters {
        actor,
        action,
        target,
        from,
        to,
    })
}

fn text<'a>(value: Option<&'a str>, path: &str, max: usize) -> AppResult<Option<&'a str>> {
    match value {
        None | Some("") => Ok(None),
        Some(s) if s.chars().count() > max || s.chars().any(char::is_control) => Err(invalid(path)),
        Some(s) => Ok(Some(s)),
    }
}

fn time_param(value: Option<&str>, path: &str) -> AppResult<Option<OffsetDateTime>> {
    match text(value, path, 64)? {
        None => Ok(None),
        Some(s) => OffsetDateTime::parse(s, &Rfc3339)
            .map(Some)
            .map_err(|_| invalid(path)),
    }
}

/// Position in the list: the last row returned. Opaque to clients.
#[derive(Clone, Copy)]
struct Cursor {
    at: OffsetDateTime,
    id: i64,
}

fn bad_cursor() -> AppError {
    invalid("cursor")
}

fn encode_cursor(at: OffsetDateTime, id: i64) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{id}", rfc3339(at)))
}

fn decode_cursor(raw: &str) -> AppResult<Cursor> {
    if raw.len() > 128 {
        return Err(bad_cursor());
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| bad_cursor())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| bad_cursor())?;
    let (at, id) = text.split_once('|').ok_or_else(bad_cursor)?;
    Ok(Cursor {
        at: OffsetDateTime::parse(at, &Rfc3339).map_err(|_| bad_cursor())?,
        id: id.parse().map_err(|_| bad_cursor())?,
    })
}

/// RFC 3339 for JSON and CSV. A valid `OffsetDateTime` always formats, so the fallback never runs.
fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap_or_default()
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: i64,
    at: OffsetDateTime,
    actor_id: Option<Uuid>,
    action: String,
    target_type: Option<String>,
    target_id: Option<String>,
    ip: Option<String>,
    user_agent: Option<String>,
    request_id: Option<String>,
    meta: Value,
}

async fn fetch_page(
    db: &PgPool,
    filters: &Filters,
    ceiling: Option<i64>,
    after: Option<Cursor>,
    limit: i64,
) -> AppResult<Vec<AuditRow>> {
    Ok(sqlx::query_as::<_, AuditRow>(LIST_SQL)
        .bind(filters.actor)
        .bind(filters.action.as_deref())
        .bind(filters.target.as_deref())
        .bind(filters.from)
        .bind(filters.to)
        .bind(ceiling)
        .bind(after.map(|c| c.at))
        .bind(after.map(|c| c.id))
        .bind(limit)
        .fetch_all(db)
        .await?)
}

fn row_json(row: &AuditRow) -> Value {
    json!({
        "id": row.id,
        "at": rfc3339(row.at),
        "actorId": row.actor_id,
        "action": row.action,
        "targetType": row.target_type,
        "targetId": row.target_id,
        "ip": row.ip,
        "userAgent": row.user_agent,
        "requestId": row.request_id,
        "meta": audit::sanitize(row.meta.clone()),
    })
}

/// Makes one CSV cell safe to open in a spreadsheet. Spreadsheets run a cell that starts with
/// `=`, `+`, `-`, `@`, tab or CR as a formula, so those get a leading `'`. Then RFC 4180 quoting.
pub(crate) fn csv_cell(value: &str) -> String {
    let guarded = match value.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{value}"),
        _ => value.to_owned(),
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn csv_line(row: &AuditRow) -> String {
    let cells = [
        row.id.to_string(),
        rfc3339(row.at),
        row.actor_id.map(|u| u.to_string()).unwrap_or_default(),
        row.action.clone(),
        row.target_type.clone().unwrap_or_default(),
        row.target_id.clone().unwrap_or_default(),
        row.ip.clone().unwrap_or_default(),
        row.user_agent.clone().unwrap_or_default(),
        row.request_id.clone().unwrap_or_default(),
        audit::sanitize(row.meta.clone()).to_string(),
    ];
    let line = cells
        .iter()
        .map(|cell| csv_cell(cell))
        .collect::<Vec<_>>()
        .join(",");
    format!("{line}\r\n")
}

/// Decides whether a count of matching rows fits the export cap. Takes the count the database
/// returned, which is capped at `MAX_EXPORT_ROWS + 1`.
pub(crate) fn check_export_size(matching: i64) -> AppResult<i64> {
    if matching > MAX_EXPORT_ROWS {
        return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "This export is too large. Narrow the filters to 50,000 rows or fewer.",
        )
        .with_details(json!([{"path":"query","message":"This export is too large. Narrow the filters to 50,000 rows or fewer."}])));
    }
    Ok(matching)
}

pub(crate) async fn list(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    query: Query<AuditQuery>,
) -> AppResult<Json<Value>> {
    let Query(q) = query;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit"));
    }
    let cursor = match q.cursor.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(decode_cursor(raw)?),
    };
    let filters = parse_filters(&q)?;
    // One extra row tells us whether another page exists without a second query.
    let mut rows = fetch_page(&state.db, &filters, None, cursor, limit + 1).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match rows.last() {
        Some(last) if more => Some(encode_cursor(last.at, last.id)),
        _ => None,
    };
    let data: Vec<Value> = rows.iter().map(row_json).collect();
    Ok(Json(json!({"data":data,"meta":{"nextCursor":next}})))
}

/// State for the streamed CSV body. Each step reads one page, so the export never holds the whole
/// result in memory and never keeps one connection busy for the whole download.
struct ExportStream {
    db: PgPool,
    filters: Filters,
    ceiling: i64,
    after: Option<Cursor>,
    remaining: i64,
    header_sent: bool,
    finished: bool,
}

async fn next_chunk(mut s: ExportStream) -> Option<(Result<Bytes, io::Error>, ExportStream)> {
    if !s.header_sent {
        s.header_sent = true;
        return Some((Ok(Bytes::from_static(CSV_HEADER.as_bytes())), s));
    }
    if s.finished || s.remaining <= 0 {
        return None;
    }
    let want = EXPORT_PAGE_ROWS.min(s.remaining);
    let page = match fetch_page(&s.db, &s.filters, Some(s.ceiling), s.after, want).await {
        Ok(page) => page,
        Err(error) => {
            // The status line is already sent, so the only signal left is a broken body.
            tracing::error!(error = ?error, "audit export page failed");
            s.finished = true;
            return Some((Err(io::Error::other("audit export interrupted")), s));
        }
    };
    if page.is_empty() {
        return None;
    }
    let fetched = page.len() as i64;
    if let Some(last) = page.last() {
        s.after = Some(Cursor {
            at: last.at,
            id: last.id,
        });
    }
    s.remaining -= fetched;
    if fetched < want || s.remaining <= 0 {
        s.finished = true;
    }
    let chunk: String = page.iter().map(csv_line).collect();
    Some((Ok(Bytes::from(chunk)), s))
}

pub(crate) async fn export(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    query: Query<AuditQuery>,
) -> AppResult<Response> {
    let Query(q) = query;
    let filters = parse_filters(&q)?;
    enforce_rate_limit(
        &state.db,
        &format!("admin:audit-export:user:{}", viewer.id),
        EXPORT_BUDGET,
    )
    .await?;
    // Snapshot the newest id first. The export's own audit row is written after this, so it has a
    // higher id and falls outside the file.
    let ceiling: i64 = sqlx::query_scalar("select coalesce(max(id),0) from audit_log")
        .fetch_one(&state.db)
        .await?;
    let matching: i64 = sqlx::query_scalar(COUNT_SQL)
        .bind(filters.actor)
        .bind(filters.action.as_deref())
        .bind(filters.target.as_deref())
        .bind(filters.from)
        .bind(filters.to)
        .bind(ceiling)
        .bind(MAX_EXPORT_ROWS + 1)
        .fetch_one(&state.db)
        .await?;
    let rows = check_export_size(matching)?;
    // Audit before the first byte goes out, so a failed audit write means no file. The row holds
    // the filters and the count, never the exported rows.
    let mut tx = state.db.begin().await?;
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        "admin.audit.export",
        ("audit_log", "export"),
        json!({"filters": filters.describe()}),
        json!({"rows": rows}),
    )
    .await?;
    tx.commit().await?;
    let body = Body::from_stream(stream::unfold(
        ExportStream {
            db: state.db.clone(),
            filters,
            ceiling,
            after: None,
            remaining: rows,
            header_sent: false,
            finished: false,
        },
        next_chunk,
    ));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"audit-log.csv\"",
        )
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(body)
        .map_err(AppError::internal)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells_are_formula_safe_and_quoted() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("+1"), "'+1");
        assert_eq!(csv_cell("-1"), "'-1");
        assert_eq!(csv_cell("@sum"), "'@sum");
        assert_eq!(csv_cell("\tx"), "'\tx");
        assert_eq!(
            csv_cell("=HYPERLINK(\"http://x\",\"go\")"),
            "\"'=HYPERLINK(\"\"http://x\"\",\"\"go\"\")\""
        );
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("line\nbreak"), "\"line\nbreak\"");
        // A formula is only dangerous at the start of a cell.
        assert_eq!(csv_cell("a=b"), "a=b");
    }

    #[test]
    fn export_refuses_more_than_the_cap() {
        assert_eq!(check_export_size(0).unwrap(), 0);
        assert_eq!(check_export_size(MAX_EXPORT_ROWS).unwrap(), MAX_EXPORT_ROWS);
        let error = check_export_size(MAX_EXPORT_ROWS + 1).unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(
            error.details.as_ref().unwrap()[0]["message"],
            "This export is too large. Narrow the filters to 50,000 rows or fewer."
        );
    }

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let at = OffsetDateTime::parse("2026-11-23T10:15:30.123456Z", &Rfc3339).unwrap();
        let encoded = encode_cursor(at, 42);
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.at, at);
        assert_eq!(decoded.id, 42);
        let long = "A".repeat(200);
        for bad in ["", "!!!", "bm90LWEtcGlwZQ", long.as_str()] {
            assert_eq!(
                decode_cursor(bad).err().unwrap().code,
                ErrorCode::ValidationFailed
            );
        }
    }

    #[test]
    fn bounds_and_enums_are_checked() {
        let long_target = "x".repeat(129);
        let bad_actor = AuditQuery {
            actor: Some("not-a-uuid".into()),
            ..Default::default()
        };
        let bad_from = AuditQuery {
            from: Some("yesterday".into()),
            ..Default::default()
        };
        let reversed = AuditQuery {
            from: Some("2026-11-24T00:00:00Z".into()),
            to: Some("2026-11-23T00:00:00Z".into()),
            ..Default::default()
        };
        let control = AuditQuery {
            action: Some("a\u{0}b".into()),
            ..Default::default()
        };
        let too_long = AuditQuery {
            target: Some(long_target),
            ..Default::default()
        };
        let empty_values = AuditQuery {
            actor: Some(String::new()),
            action: Some(String::new()),
            ..Default::default()
        };
        assert!(parse_filters(&bad_actor).is_err());
        assert!(parse_filters(&bad_from).is_err());
        assert!(parse_filters(&reversed).is_err());
        assert!(parse_filters(&control).is_err());
        assert!(parse_filters(&too_long).is_err());
        assert!(parse_filters(&empty_values).is_ok());
    }
}
