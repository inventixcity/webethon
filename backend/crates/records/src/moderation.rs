//! Moderation helpers for the admin area. These are plain functions with no HTTP route. The admin
//! crate adds the global-admin check, step-up and before/after audit around them.
//!
//! Rules that hold for every function here:
//! - Every change that actually happens bumps `version`, so clients using If-Match see it.
//! - A no-op (hiding an already hidden record) changes nothing and does not bump `version`.
//! - Hide and unhide touch only `admin_hidden_at`. They never change data or visibility.
//! - Admin list and get show every row for the entity, personal and team, hidden and deleted. These
//!   are the admin-surface reads, so they skip team membership on purpose. Ordinary `get`/`list`
//!   in `service.rs` still require membership, so a global admin gets 404 there on team rows.
//!   Admin writes by id may target team rows, because those are explicit calls.

use crate::service::Record;
use kernel::{AppError, AppResult, ErrorCode};
use serde_json::json;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// A record as admins see it, including soft-deleted rows.
pub struct AdminRecord {
    pub record: Record,
    pub deleted_at: Option<OffsetDateTime>,
}

#[derive(FromRow)]
struct AdminRow {
    #[sqlx(flatten)]
    record: Record,
    deleted_at: Option<OffsetDateTime>,
}

/// Optional filters for `admin_list`. `None` means "don't filter on this field".
#[derive(Default)]
pub struct AdminFilter {
    /// `Some(true)` = hidden only, `Some(false)` = not hidden only.
    pub hidden: Option<bool>,
    /// `Some(true)` = deleted only, `Some(false)` = live only.
    pub deleted: Option<bool>,
    /// `"public"` or `"private"`.
    pub visibility: Option<String>,
}

pub struct AdminPage {
    pub items: Vec<AdminRecord>,
    /// `(created_at, id)` of the last item when more rows exist.
    pub next: Option<(OffsetDateTime, Uuid)>,
}

const SELECT: &str = "select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at,r.deleted_at from records r";

/// Admin hide or unhide for any live record, team rows included. Callers must have checked that
/// the viewer is a global admin.
pub async fn set_admin_hidden(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    hidden: bool,
) -> AppResult<i32> {
    set_hidden(tx, id, hidden, true).await
}

/// Hide or unhide through a non-admin path. Team rows are refused with VALIDATION_FAILED, so team
/// moderation only happens through `set_admin_hidden`. The records crate has no public hide route
/// today; this exists so that any future caller gets the same team rule.
pub async fn set_personal_hidden(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    hidden: bool,
) -> AppResult<i32> {
    set_hidden(tx, id, hidden, false).await
}

async fn set_hidden(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    hidden: bool,
    allow_team: bool,
) -> AppResult<i32> {
    // Lock the row so the check and the update see the same state.
    let (team, hidden_at, version): (Option<Uuid>, Option<OffsetDateTime>, i32) = sqlx::query_as(
        "select team_id,admin_hidden_at,version from records where id=$1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    if team.is_some() && !allow_team {
        return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please check the highlighted fields.",
        )
        .with_details(json!([{"path":"teamId","message":"This record belongs to a team."}])));
    }
    if hidden_at.is_some() == hidden {
        return Ok(version);
    }
    let version: i32 = sqlx::query_scalar(
        "update records set admin_hidden_at=case when $2 then now() else null end,version=version+1 where id=$1 returning version",
    )
    .bind(id)
    .bind(hidden)
    .fetch_one(&mut **tx)
    .await?;
    Ok(version)
}

/// Soft-delete a live record. Team rows are allowed here by explicit admin choice.
pub async fn admin_soft_delete(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> AppResult<i32> {
    sqlx::query_scalar(
        "update records set deleted_at=now(),version=version+1 where id=$1 and deleted_at is null returning version",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(AppError::not_found)
}

/// Restore a soft-deleted record. The hidden flag is left as it is.
pub async fn admin_restore(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> AppResult<i32> {
    sqlx::query_scalar(
        "update records set deleted_at=null,version=version+1 where id=$1 and deleted_at is not null returning version",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(AppError::not_found)
}

/// Read one record, personal or team, deleted or not, for the admin detail view.
pub async fn admin_get(db: &PgPool, entity: &str, id: Uuid) -> AppResult<AdminRecord> {
    let row: AdminRow = sqlx::query_as(&format!("{SELECT} where r.entity=$1 and r.id=$2"))
        .bind(entity)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok(AdminRecord {
        record: row.record,
        deleted_at: row.deleted_at,
    })
}

/// Newest first, keyset-paged. Covers personal and team rows. `limit` must be 1..=100.
pub async fn admin_list(
    db: &PgPool,
    entity: &str,
    filter: &AdminFilter,
    limit: i64,
    after: Option<(OffsetDateTime, Uuid)>,
) -> AppResult<AdminPage> {
    if !(1..=100).contains(&limit) {
        return Err(AppError::bad_request("Invalid limit."));
    }
    if let Some(v) = &filter.visibility
        && v != "public"
        && v != "private"
    {
        return Err(AppError::bad_request(
            "Please check the highlighted fields.",
        ));
    }
    let mut b = sqlx::QueryBuilder::<Postgres>::new(SELECT);
    b.push(" where r.entity=").push_bind(entity);
    match filter.hidden {
        Some(true) => {
            b.push(" and r.admin_hidden_at is not null");
        }
        Some(false) => {
            b.push(" and r.admin_hidden_at is null");
        }
        None => {}
    }
    match filter.deleted {
        Some(true) => {
            b.push(" and r.deleted_at is not null");
        }
        Some(false) => {
            b.push(" and r.deleted_at is null");
        }
        None => {}
    }
    if let Some(v) = &filter.visibility {
        b.push(" and r.visibility=").push_bind(v.as_str());
    }
    if let Some((at, id)) = after {
        b.push(" and (r.created_at,r.id)<(")
            .push_bind(at)
            .push(",")
            .push_bind(id)
            .push(")");
    }
    b.push(" order by r.created_at desc, r.id desc limit ")
        .push_bind(limit + 1);
    let mut rows: Vec<AdminRow> = b.build_query_as().fetch_all(db).await?;
    let more = rows.len() > limit as usize;
    if more {
        rows.pop();
    }
    let next = if more {
        rows.last().map(|r| (r.record.created_at, r.record.id))
    } else {
        None
    };
    Ok(AdminPage {
        items: rows
            .into_iter()
            .map(|row| AdminRecord {
                record: row.record,
                deleted_at: row.deleted_at,
            })
            .collect(),
        next,
    })
}
