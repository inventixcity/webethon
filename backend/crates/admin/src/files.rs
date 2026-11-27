//! Files for admin review. The list and the detail show metadata only: the storage key is never
//! selected for a response, so it can't reach one. A delete is a soft delete in the database, the
//! same column the owner's delete uses. The bytes are removed after the commit, through the storage
//! the server already holds for uploads.

use crate::{
    AdminViewer, audit, security as admin_security,
    shared::{
        MAX_SEARCH_CHARS, bounded_limit, encode_cursor, like_pattern, optional_cursor, parse_id,
        rfc3339, text, uuid_filter,
    },
};
use axum::{
    Json,
    extract::{Extension, State},
    http::StatusCode,
};
use kernel::extract::{Path, Query};
// The leading `::` names the storage crate, not this module.
use ::files::Storage;
use kernel::{
    AppError, AppResult, AppState,
    request::RequestMeta,
    security::{self, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder};
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

// Column lists are fixed here. `key` is read only by the delete path, which never returns it.
const DETAIL_SQL: &str = "select id,owner_id,original_name,content_type,size_bytes,created_at,deleted_at from files where id=$1";
const OWNER_SQL: &str = "select owner_id from files where id=$1";
const LOCK_SQL: &str =
    "select owner_id,size_bytes,key from files where id=$1 and deleted_at is null for update";
const SOFT_DELETE_SQL: &str =
    "update files set deleted_at=now() where id=$1 and deleted_at is null";

/// Metadata only: no storage key, path, URL or checksum.
#[derive(FromRow)]
struct Row {
    id: Uuid,
    owner_id: Uuid,
    original_name: Option<String>,
    content_type: String,
    size_bytes: i64,
    created_at: OffsetDateTime,
    deleted_at: Option<OffsetDateTime>,
}

impl Row {
    fn json(&self) -> AppResult<Value> {
        Ok(json!({
            "id": self.id,
            "ownerId": self.owner_id,
            "name": self.original_name,
            "contentType": self.content_type,
            "size": self.size_bytes,
            "createdAt": rfc3339(self.created_at)?,
            "deletedAt": self.deleted_at.map(rfc3339).transpose()?,
        }))
    }
}

// ----------------------------------------------------------------------------------------------
// List

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileQuery {
    owner_id: Option<String>,
    deleted: Option<bool>,
    q: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    query: Query<FileQuery>,
) -> AppResult<Json<Value>> {
    let Query(q) = query;
    let limit = bounded_limit(q.limit)?;
    let owner = uuid_filter(q.owner_id.as_deref(), "ownerId")?;
    let search = text(q.q.as_deref(), "q", MAX_SEARCH_CHARS)?;
    let cursor = optional_cursor(q.cursor.as_deref())?;
    let mut b = QueryBuilder::<Postgres>::new(
        "select id,owner_id,original_name,content_type,size_bytes,created_at,deleted_at from files where true",
    );
    b.push(if q.deleted.unwrap_or(false) {
        " and deleted_at is not null"
    } else {
        " and deleted_at is null"
    });
    if let Some(owner) = owner {
        b.push(" and owner_id=").push_bind(owner);
    }
    // Matches the file name only. A file with no name never matches a search.
    if let Some(search) = search {
        b.push(" and original_name ilike ")
            .push_bind(like_pattern(search))
            .push(" escape '\\'");
    }
    if let Some(c) = cursor {
        b.push(" and (created_at,id)<(")
            .push_bind(c.at)
            .push(",")
            .push_bind(c.id)
            .push(")");
    }
    b.push(" order by created_at desc,id desc limit ")
        .push_bind(limit + 1);
    let mut rows: Vec<Row> = b.build_query_as::<Row>().fetch_all(&state.db).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match rows.last() {
        Some(last) if more => Some(encode_cursor(last.created_at, last.id)?),
        _ => None,
    };
    let data = rows.iter().map(Row::json).collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({"data":data,"meta":{"nextCursor":next}})))
}

// ----------------------------------------------------------------------------------------------
// Detail

pub(crate) async fn detail(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    path: Path<String>,
) -> AppResult<Json<Value>> {
    let Path(raw) = path;
    let id = parse_id(&raw)?;
    let row = fetch_one(&state.db, id).await?;
    let mut body = row.json()?;
    body["history"] = Value::Array(audit::history(&state.db, "file", id).await?);
    Ok(Json(json!({"data":body})))
}

async fn fetch_one(db: &PgPool, id: Uuid) -> AppResult<Row> {
    sqlx::query_as::<_, Row>(DETAIL_SQL)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(AppError::not_found)
}

// ----------------------------------------------------------------------------------------------
// Delete

/// The soft delete happens in the transaction with the audit row. The bytes are removed after the
/// commit, so a failed purge never leaves a visible file behind. The purge is best effort: when it
/// fails the request still succeeds, the failure is logged by file id only, and the bytes stay
/// until a later cleanup. The storage key is never logged or returned.
pub(crate) async fn delete(
    State(state): State<AppState>,
    AdminViewer(viewer): AdminViewer,
    meta: RequestMeta,
    Extension(storage): Extension<Arc<dyn Storage>>,
    path: Path<String>,
) -> AppResult<StatusCode> {
    let Path(raw) = path;
    let id = parse_id(&raw)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:files:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:files:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    // Owner first, so the lock order matches the user actions: actor, then owner.
    let owner: Option<Uuid> = sqlx::query_scalar(OWNER_SQL)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let owner = owner.ok_or_else(AppError::not_found)?;
    admin_security::lock_users_in_order(&mut tx, viewer.id, owner).await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    // Locked after the step-up check. An already deleted file is not found, so it writes no audit row.
    let locked: Option<(Uuid, i64, String)> = sqlx::query_as(LOCK_SQL)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let (owner_id, size, key) = locked.ok_or_else(AppError::not_found)?;
    let before = json!({"ownerId": owner_id, "sizeBytes": size, "deleted": false});
    let result = sqlx::query(SOFT_DELETE_SQL)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    let after = json!({"ownerId": owner_id, "sizeBytes": size, "deleted": true});
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        "admin.files.delete",
        ("file", &id.to_string()),
        before,
        after,
    )
    .await?;
    tx.commit().await?;
    // The key comes from the database row, never from the request. It is not logged.
    if storage.delete(&key).await.is_err() {
        tracing::warn!(file_id = %id, "admin file delete: byte purge failed after the soft delete");
    }
    Ok(StatusCode::NO_CONTENT)
}
