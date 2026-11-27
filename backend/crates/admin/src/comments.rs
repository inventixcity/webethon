//! Comment moderation for admins: a filtered list, hide, unhide and soft delete.
//!
//! This list is the only admin read that returns a hidden comment's body. Every ordinary social
//! read keeps the placeholder. The list also returns the body of an author-deleted comment that is
//! not hidden, whose placeholder rule `social::moderation::AdminComment` keeps. Hide and unhide
//! call social's moderation function. Delete is a soft delete on the social table's `deleted_at`.

use crate::{
    AdminViewer, audit, security as admin_security,
    shared::{
        MAX_ENTITY_CHARS, MAX_SEARCH_CHARS, bounded_limit, encode_cursor, invalid, like_pattern,
        load_registry_cached, optional_cursor, parse_id, text, uuid_filter,
    },
};
use axum::{Json, extract::State, http::StatusCode};
use kernel::extract::{Path, Query};
use kernel::{
    AppError, AppResult, AppState, Viewer,
    request::RequestMeta,
    security::{self, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use social::moderation::{self, AdminComment};
use sqlx::{Postgres, QueryBuilder, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

// ----------------------------------------------------------------------------------------------
// List

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommentQuery {
    q: Option<String>,
    entity: Option<String>,
    record_id: Option<String>,
    hidden: Option<bool>,
    deleted: Option<bool>,
    limit: Option<i64>,
    cursor: Option<String>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    query: Query<CommentQuery>,
) -> AppResult<Json<Value>> {
    let Query(q) = query;
    let limit = bounded_limit(q.limit)?;
    let search = text(q.q.as_deref(), "q", MAX_SEARCH_CHARS)?;
    let entity = text(q.entity.as_deref(), "entity", MAX_ENTITY_CHARS)?;
    if let Some(name) = entity {
        // A filter that names no entity is a bad request (400), unlike a missing record (404).
        // The name is then bound as a value, never spliced into SQL.
        load_registry_cached(&state)?
            .definition(name)
            .map_err(|_| invalid("entity"))?;
    }
    let record_id = uuid_filter(q.record_id.as_deref(), "recordId")?;
    let cursor = optional_cursor(q.cursor.as_deref())?;
    // Same keyset order as the other admin lists: newest first, with the id as the tie-breaker.
    let mut b = QueryBuilder::<Postgres>::new(
        "select c.id,c.entity,c.record_id,c.author_id,c.parent_id,c.body,c.created_at,c.updated_at,c.deleted_at,c.admin_hidden_at from social_comments c where true",
    );
    if let Some(name) = entity {
        b.push(" and c.entity=").push_bind(name);
    }
    if let Some(record) = record_id {
        b.push(" and c.record_id=").push_bind(record);
    }
    if let Some(hidden) = q.hidden {
        b.push(if hidden {
            " and c.admin_hidden_at is not null"
        } else {
            " and c.admin_hidden_at is null"
        });
    }
    b.push(if q.deleted.unwrap_or(false) {
        " and c.deleted_at is not null"
    } else {
        " and c.deleted_at is null"
    });
    if let Some(search) = search {
        // Only a body that is shown can match. An author-deleted comment that is not hidden shows a
        // placeholder, so its text must not be searchable either, or a search would leak it.
        b.push(" and (c.deleted_at is null or c.admin_hidden_at is not null) and c.body ilike ")
            .push_bind(like_pattern(search))
            .push(" escape '\\'");
    }
    if let Some(c) = cursor {
        b.push(" and (c.created_at,c.id)<(")
            .push_bind(c.at)
            .push(",")
            .push_bind(c.id)
            .push(")");
    }
    b.push(" order by c.created_at desc,c.id desc limit ")
        .push_bind(limit + 1);
    let mut rows: Vec<AdminComment> = b
        .build_query_as::<AdminComment>()
        .fetch_all(&state.db)
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match rows.last() {
        Some(last) if more => Some(encode_cursor(last.created_at, last.id)?),
        _ => None,
    };
    let data = rows
        .iter()
        .map(AdminComment::json)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({"data":data,"meta":{"nextCursor":next}})))
}

// ----------------------------------------------------------------------------------------------
// Actions

#[derive(Clone, Copy)]
enum Op {
    Hide,
    Unhide,
    Delete,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Hide => "hide",
            Op::Unhide => "unhide",
            Op::Delete => "delete",
        }
    }
}

const AUTHOR_SQL: &str = "select author_id from social_comments where id=$1";
const LOCK_SQL: &str =
    "select admin_hidden_at,deleted_at from social_comments where id=$1 for update";
const READ_SQL: &str = "select admin_hidden_at,deleted_at from social_comments where id=$1";
const SOFT_DELETE_SQL: &str = "update social_comments set deleted_at=now(),updated_at=now() where id=$1 and deleted_at is null";

/// Only the state flags go into the audit row. The comment body never does.
async fn snapshot(tx: &mut Transaction<'_, Postgres>, id: Uuid, lock: bool) -> AppResult<Value> {
    let sql = if lock { LOCK_SQL } else { READ_SQL };
    let row: Option<(Option<OffsetDateTime>, Option<OffsetDateTime>)> = sqlx::query_as(sql)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let (hidden_at, deleted_at) = row.ok_or_else(AppError::not_found)?;
    Ok(json!({
        "hidden": hidden_at.is_some(),
        "deleted": deleted_at.is_some(),
    }))
}

async fn mutate(
    state: AppState,
    meta: RequestMeta,
    viewer: Viewer,
    raw_id: String,
    op: Op,
) -> AppResult<StatusCode> {
    let id = parse_id(&raw_id)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:comments:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:comments:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    // Author first, so the lock order matches the user actions: actor, then author.
    let author: Option<Uuid> = sqlx::query_scalar(AUTHOR_SQL)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let author = author.ok_or_else(AppError::not_found)?;
    admin_security::lock_users_in_order(&mut tx, viewer.id, author).await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    let before = snapshot(&mut tx, id, true).await?;
    match op {
        Op::Hide => moderation::set_comment_admin_hidden(&mut tx, id, true).await?,
        Op::Unhide => moderation::set_comment_admin_hidden(&mut tx, id, false).await?,
        Op::Delete => {
            let result = sqlx::query(SOFT_DELETE_SQL)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::not_found());
            }
        }
    }
    let after = snapshot(&mut tx, id, false).await?;
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        &format!("admin.comments.{}", op.name()),
        ("comment", &id.to_string()),
        before,
        after,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

macro_rules! action {
    ($name:ident, $op:expr) => {
        pub(crate) async fn $name(
            State(state): State<AppState>,
            meta: RequestMeta,
            AdminViewer(viewer): AdminViewer,
            path: Path<String>,
        ) -> AppResult<StatusCode> {
            let Path(raw_id) = path;
            mutate(state, meta, viewer, raw_id, $op).await
        }
    };
}
action!(hide, Op::Hide);
action!(unhide, Op::Unhide);
action!(delete, Op::Delete);
