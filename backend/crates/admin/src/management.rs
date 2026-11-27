use crate::{
    AdminViewer, audit, security,
    shared::{
        MAX_SEARCH_CHARS, bounded_limit, encode_cursor, invalid, like_pattern, optional_cursor,
        parse_id, text,
    },
};
use axum::{Json, extract::State, http::StatusCode};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer,
    extract::{Path, Query},
    request::RequestMeta,
    security::{self as rates, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, QueryBuilder};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    status: Option<String>,
    kind: Option<String>,
    q: Option<String>,
    hidden: Option<bool>,
    visibility: Option<String>,
    category: Option<String>,
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    created_at: OffsetDateTime,
    data: Value,
}

pub(crate) async fn jobs(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    if q.q.is_some() || q.hidden.is_some() || q.visibility.is_some() || q.category.is_some() {
        return Err(invalid("query"));
    }
    let limit = bounded_limit(q.limit)?;
    let cursor = optional_cursor(q.cursor.as_deref())?;
    let status = text(q.status.as_deref(), "status", 16)?;
    if status.is_some_and(|s| !["queued", "running", "done", "failed", "dead"].contains(&s)) {
        return Err(invalid("status"));
    }
    let kind = text(q.kind.as_deref(), "kind", 100)?;
    let mut b = QueryBuilder::<Postgres>::new(
        "select id,created_at,jsonb_build_object('id',id,'kind',kind,'status',status,'runAt',run_at,'attempts',attempts,'maxAttempts',max_attempts,'createdAt',created_at,'finishedAt',finished_at) as data from jobs where true",
    );
    if let Some(s) = status {
        b.push(" and status=").push_bind(s);
    }
    if let Some(k) = kind {
        b.push(" and kind=").push_bind(k);
    }
    page(b, cursor, limit, &state).await
}
pub(crate) async fn places(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    if q.status.is_some() || q.kind.is_some() {
        return Err(invalid("query"));
    }
    let limit = bounded_limit(q.limit)?;
    let cursor = optional_cursor(q.cursor.as_deref())?;
    let search = text(q.q.as_deref(), "q", MAX_SEARCH_CHARS)?;
    let category = text(q.category.as_deref(), "category", 40)?;
    let visibility = text(q.visibility.as_deref(), "visibility", 7)?;
    if visibility.is_some_and(|v| v != "public" && v != "private") {
        return Err(invalid("visibility"));
    }
    let mut b = QueryBuilder::<Postgres>::new(
        "select id,created_at,jsonb_build_object('id',id,'ownerId',owner_id,'name',name,'description',description,'lat',lat,'lng',lng,'address',address,'category',category,'visibility',visibility,'moderationHidden',admin_hidden_at is not null,'createdAt',created_at,'updatedAt',updated_at) as data from places where deleted_at is null",
    );
    if let Some(h) = q.hidden {
        b.push(if h {
            " and admin_hidden_at is not null"
        } else {
            " and admin_hidden_at is null"
        });
    }
    if let Some(v) = visibility {
        b.push(" and visibility=").push_bind(v);
    }
    if let Some(c) = category {
        b.push(" and category=").push_bind(c);
    }
    if let Some(s) = search {
        b.push(" and (name ilike ")
            .push_bind(like_pattern(s))
            .push(" escape '\\' or address ilike ")
            .push_bind(like_pattern(s))
            .push(" escape '\\')");
    }
    page(b, cursor, limit, &state).await
}
async fn page(
    mut b: QueryBuilder<'_, Postgres>,
    cursor: Option<crate::shared::Cursor>,
    limit: i64,
    state: &AppState,
) -> AppResult<Json<Value>> {
    if let Some(c) = cursor {
        b.push(" and (created_at,id)<(")
            .push_bind(c.at)
            .push(",")
            .push_bind(c.id)
            .push(")");
    }
    b.push(" order by created_at desc,id desc limit ")
        .push_bind(limit + 1);
    let mut rows: Vec<Row> = b.build_query_as().fetch_all(&state.db).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match rows.last() {
        Some(r) if more => Some(encode_cursor(r.created_at, r.id)?),
        _ => None,
    };
    Ok(Json(
        json!({"data":rows.into_iter().map(|r|r.data).collect::<Vec<_>>(),"meta":{"nextCursor":next}}),
    ))
}
async fn change(
    state: AppState,
    meta: RequestMeta,
    viewer: Viewer,
    raw: String,
    operation: &str,
) -> AppResult<StatusCode> {
    let id = parse_id(&raw)?;
    rates::enforce_rate_limit(
        &state.db,
        &format!("admin:management:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    rates::enforce_rate_limit(
        &state.db,
        &format!("admin:management:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    security::require_step_up(&mut tx, &state, &viewer).await?;
    let (target, before, after) = if operation == "hide" || operation == "unhide" {
        let previous:Option<bool>=sqlx::query_scalar("select admin_hidden_at is not null from places where id=$1 and deleted_at is null for update").bind(id).fetch_optional(&mut *tx).await?;
        let previous = previous.ok_or_else(AppError::not_found)?;
        let hidden = operation == "hide";
        sqlx::query("update places set admin_hidden_at=case when $2 then coalesce(admin_hidden_at,now()) else null end where id=$1 and deleted_at is null").bind(id).bind(hidden).execute(&mut *tx).await?;
        (
            "place",
            json!({"hidden":previous}),
            json!({"hidden":hidden}),
        )
    } else {
        let previous: Option<String> =
            sqlx::query_scalar("select status from jobs where id=$1 for update")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let previous = previous.ok_or_else(AppError::not_found)?;
        if (operation == "retry" && previous != "failed" && previous != "dead")
            || (operation == "cancel" && previous != "queued")
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "This job cannot be changed in its current state.",
            ));
        }
        let sql = if operation == "retry" {
            "update jobs set status='queued',attempts=0,run_at=now(),finished_at=null,locked_until=null,locked_by=null,last_error=null where id=$1 and status=$2"
        } else {
            "update jobs set status='dead',finished_at=now(),locked_until=null,locked_by=null where id=$1 and status=$2"
        };
        let result = sqlx::query(sql)
            .bind(id)
            .bind(&previous)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                if kernel::error::is_unique_violation(&e) {
                    AppError::new(ErrorCode::Conflict, "A matching job is already queued.")
                } else {
                    AppError::from(e)
                }
            })?;
        if result.rows_affected() != 1 {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "This job cannot be changed in its current state.",
            ));
        }
        (
            "job",
            json!({"status":previous}),
            json!({"status":if operation=="retry" {"queued"} else {"dead"}}),
        )
    };
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        &format!("admin.{target}s.{operation}"),
        (target, &id.to_string()),
        before,
        after,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
macro_rules! action {
    ($name:ident,$op:literal) => {
        pub(crate) async fn $name(
            State(state): State<AppState>,
            meta: RequestMeta,
            AdminViewer(viewer): AdminViewer,
            Path(id): Path<String>,
        ) -> AppResult<StatusCode> {
            change(state, meta, viewer, id, $op).await
        }
    };
}
action!(hide, "hide");
action!(unhide, "unhide");
action!(retry, "retry");
action!(cancel, "cancel");
