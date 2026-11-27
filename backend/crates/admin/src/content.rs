//! Content moderation for every configured entity: a filtered list, a detail view with history, and
//! hide, unhide, delete and restore. Records owns the rules (`records::moderation`). This module
//! adds the admin checks around them: step-up, a rate budget, and a before/after audit row written
//! in the same transaction.

use crate::{
    AdminViewer, audit, security as admin_security,
    shared::{
        self, MAX_ENTITY_CHARS, MAX_SEARCH_CHARS, invalid, known_entity, like_pattern,
        load_registry_cached, optional_cursor, parse_id, rfc3339, text,
    },
};
use axum::{Json, extract::State, http::StatusCode};
use kernel::extract::{Path, Query};
use kernel::{
    AppError, AppResult, AppState, Viewer,
    request::RequestMeta,
    security::{self, limits},
};
use records::{
    moderation::{self, AdminRecord},
    registry::EntityDefinition,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

// ----------------------------------------------------------------------------------------------
// Rows

/// One record as the admin list and detail show it. No record data, so a list page can't leak
/// content and stays small.
#[derive(FromRow)]
struct Row {
    id: Uuid,
    entity: String,
    owner_id: Uuid,
    team_id: Option<Uuid>,
    visibility: String,
    admin_hidden_at: Option<OffsetDateTime>,
    deleted_at: Option<OffsetDateTime>,
    version: i32,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

impl Row {
    fn from_admin(found: &AdminRecord) -> Self {
        let record = &found.record;
        Self {
            id: record.id,
            entity: record.entity.clone(),
            owner_id: record.owner_id,
            team_id: record.team_id,
            visibility: record.visibility.clone(),
            admin_hidden_at: record.admin_hidden_at,
            deleted_at: found.deleted_at,
            version: record.version,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }

    fn json(&self) -> AppResult<Value> {
        Ok(json!({
            "id": self.id,
            "entity": self.entity,
            "ownerId": self.owner_id,
            "teamId": self.team_id,
            "visibility": self.visibility,
            "moderationHidden": self.admin_hidden_at.is_some(),
            "deleted": self.deleted_at.is_some(),
            "version": self.version,
            "createdAt": rfc3339(self.created_at)?,
            "updatedAt": rfc3339(self.updated_at)?,
        }))
    }
}

// ----------------------------------------------------------------------------------------------
// List

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentQuery {
    entity: Option<String>,
    q: Option<String>,
    visibility: Option<String>,
    deleted: Option<bool>,
    hidden: Option<bool>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Visibility {
    Public,
    Private,
    Team,
}

fn visibility_filter(value: Option<&str>) -> AppResult<Option<Visibility>> {
    match value {
        None | Some("") => Ok(None),
        Some("public") => Ok(Some(Visibility::Public)),
        Some("private") => Ok(Some(Visibility::Private)),
        Some("team") => Ok(Some(Visibility::Team)),
        Some(_) => Err(invalid("visibility")),
    }
}

struct Filters {
    search: Option<String>,
    visibility: Option<Visibility>,
    deleted: bool,
    hidden: Option<bool>,
}

/// Keyset page, newest first. Filters that are not set are not added to the SQL at all.
async fn fetch_page(
    db: &PgPool,
    entity: &str,
    def: &EntityDefinition,
    filters: &Filters,
    after: Option<shared::Cursor>,
    limit: i64,
) -> AppResult<Vec<Row>> {
    let mut b = QueryBuilder::<Postgres>::new(
        "select r.id,r.entity,r.owner_id,r.team_id,r.visibility,r.admin_hidden_at,r.deleted_at,r.version,r.created_at,r.updated_at from records r where r.entity=",
    );
    b.push_bind(entity);
    b.push(if filters.deleted {
        " and r.deleted_at is not null"
    } else {
        " and r.deleted_at is null"
    });
    match filters.hidden {
        Some(true) => {
            b.push(" and r.admin_hidden_at is not null");
        }
        Some(false) => {
            b.push(" and r.admin_hidden_at is null");
        }
        None => {}
    }
    match filters.visibility {
        Some(Visibility::Public) => {
            b.push(" and r.visibility='public'");
        }
        // Team rows are always private in the database, so "private" means personal private rows.
        Some(Visibility::Private) => {
            b.push(" and r.visibility='private' and r.team_id is null");
        }
        Some(Visibility::Team) => {
            b.push(" and r.team_id is not null");
        }
        None => {}
    }
    // Same search as the records list: a case-insensitive substring match over the entity's
    // searchable fields. The field name is bound as a value, never spliced into SQL.
    if let Some(search) = &filters.search {
        let pattern = like_pattern(search);
        b.push(" and (");
        for (i, name) in def.searchable.iter().enumerate() {
            if i > 0 {
                b.push(" or ");
            }
            b.push("r.data ->> ")
                .push_bind(name)
                .push(" ilike ")
                .push_bind(pattern.clone())
                .push(" escape '\\'");
        }
        b.push(")");
    }
    if let Some(c) = after {
        b.push(" and (r.created_at,r.id)<(")
            .push_bind(c.at)
            .push(",")
            .push_bind(c.id)
            .push(")");
    }
    b.push(" order by r.created_at desc,r.id desc limit ")
        .push_bind(limit);
    Ok(b.build_query_as::<Row>().fetch_all(db).await?)
}

pub(crate) async fn list(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    query: Query<ContentQuery>,
) -> AppResult<Json<Value>> {
    let Query(q) = query;
    let limit = shared::bounded_limit(q.limit)?;
    let entity =
        text(q.entity.as_deref(), "entity", MAX_ENTITY_CHARS)?.ok_or_else(|| invalid("entity"))?;
    let registry = load_registry_cached(&state)?;
    let def = registry.definition(entity)?;
    let search = text(q.q.as_deref(), "q", MAX_SEARCH_CHARS)?.map(str::to_owned);
    if search.is_some() && def.searchable.is_empty() {
        return Err(invalid("q"));
    }
    let filters = Filters {
        search,
        visibility: visibility_filter(q.visibility.as_deref())?,
        deleted: q.deleted.unwrap_or(false),
        hidden: q.hidden,
    };
    let cursor = optional_cursor(q.cursor.as_deref())?;
    // One extra row tells us whether another page exists without a second query.
    let mut rows = fetch_page(&state.db, entity, def, &filters, cursor, limit + 1).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match rows.last() {
        Some(last) if more => Some(shared::encode_cursor(last.created_at, last.id)?),
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
    path: Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let Path((entity, raw_id)) = path;
    known_entity(&state, &entity)?;
    let id = parse_id(&raw_id)?;
    let found = moderation::admin_get(&state.db, &entity, id).await?;
    let mut body = Row::from_admin(&found).json()?;
    let history = audit::history(&state.db, "record", id).await?;
    // The record's own JSON is the one field that is not sanitized: it is the content being
    // moderated, and redacting keys in it would change what the admin is reviewing.
    body["data"] = found.record.data;
    body["history"] = Value::Array(history);
    Ok(Json(json!({"data":body})))
}

// ----------------------------------------------------------------------------------------------
// Actions

#[derive(Clone, Copy)]
enum Op {
    Hide,
    Unhide,
    Delete,
    Restore,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Hide => "hide",
            Op::Unhide => "unhide",
            Op::Delete => "delete",
            Op::Restore => "restore",
        }
    }
}

/// Only the state flags go into the audit row, never record data.
async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    entity: &str,
    id: Uuid,
    lock: bool,
) -> AppResult<Value> {
    // Both statements are fixed here; the entity and id are bound as values.
    let sql = if lock {
        "select version,admin_hidden_at,deleted_at from records where entity=$1 and id=$2 for update"
    } else {
        "select version,admin_hidden_at,deleted_at from records where entity=$1 and id=$2"
    };
    let row: Option<(i32, Option<OffsetDateTime>, Option<OffsetDateTime>)> = sqlx::query_as(sql)
        .bind(entity)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let (version, hidden_at, deleted_at) = row.ok_or_else(AppError::not_found)?;
    Ok(json!({
        "version": version,
        "moderationHidden": hidden_at.is_some(),
        "deleted": deleted_at.is_some(),
    }))
}

async fn mutate(
    state: AppState,
    meta: RequestMeta,
    viewer: Viewer,
    entity: String,
    raw_id: String,
    op: Op,
) -> AppResult<StatusCode> {
    known_entity(&state, &entity)?;
    let id = parse_id(&raw_id)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:content:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:content:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    // The owner is looked up first so the lock order matches the user actions: actor, then owner.
    // The entity check here stops a path that names the wrong entity from reaching the record.
    let owner: Option<Uuid> =
        sqlx::query_scalar("select owner_id from records where entity=$1 and id=$2")
            .bind(&entity)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let owner = owner.ok_or_else(AppError::not_found)?;
    admin_security::lock_users_in_order(&mut tx, viewer.id, owner).await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    let before = snapshot(&mut tx, &entity, id, true).await?;
    match op {
        Op::Hide => {
            moderation::set_admin_hidden(&mut tx, id, true).await?;
        }
        Op::Unhide => {
            moderation::set_admin_hidden(&mut tx, id, false).await?;
        }
        Op::Delete => {
            moderation::admin_soft_delete(&mut tx, id).await?;
        }
        Op::Restore => {
            moderation::admin_restore(&mut tx, id).await?;
        }
    }
    let after = snapshot(&mut tx, &entity, id, false).await?;
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        &format!("admin.content.{}", op.name()),
        ("record", &id.to_string()),
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
            path: Path<(String, String)>,
        ) -> AppResult<StatusCode> {
            let Path((entity, raw_id)) = path;
            mutate(state, meta, viewer, entity, raw_id, $op).await
        }
    };
}
action!(hide, Op::Hide);
action!(unhide, Op::Unhide);
action!(delete, Op::Delete);
action!(restore, Op::Restore);
