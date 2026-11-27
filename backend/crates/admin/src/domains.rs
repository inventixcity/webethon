use crate::{AdminViewer, JsonBody, audit, security as admin_security, shared};
use axum::{Json, extract::State};
use kernel::extract::{Path, Query};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer,
    request::RequestMeta,
    security::{enforce_rate_limit, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct List {
    q: Option<String>,
    status: Option<String>,
    resource: Option<String>,
    user: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

async fn page(state: &AppState, q: List, teams: bool) -> AppResult<Json<Value>> {
    let limit = shared::bounded_limit(q.limit)?;
    let cursor = shared::optional_cursor(q.cursor.as_deref())?;
    let search = shared::text(q.q.as_deref(), "q", shared::MAX_SEARCH_CHARS)?;
    let status = shared::text(q.status.as_deref(), "status", 16)?;
    let resource = shared::uuid_filter(q.resource.as_deref(), "resource")?;
    let user = shared::uuid_filter(q.user.as_deref(), "user")?;
    if teams && (status.is_some() || resource.is_some() || user.is_some())
        || !teams && search.is_some()
    {
        return Err(shared::invalid("query"));
    }
    if status.is_some_and(|s| s != "confirmed" && s != "cancelled") {
        return Err(shared::invalid("status"));
    }
    let (at, id) = cursor
        .map(|c| (Some(c.at), Some(c.id)))
        .unwrap_or((None, None));
    let rows: Vec<(Uuid, time::OffsetDateTime, Value)> = if teams {
        sqlx::query_as("select t.id,t.created_at,jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'createdAt',t.created_at,'memberCount',(select count(*) from team_members m where m.team_id=t.id)) from teams t where t.deleted_at is null and ($1::text is null or t.name ilike $1 escape '\\' or t.slug ilike $1 escape '\\') and ($2::timestamptz is null or (t.created_at,t.id)<($2,$3)) order by t.created_at desc,t.id desc limit $4")
        .bind(search.map(shared::like_pattern)).bind(at).bind(id).bind(limit+1).fetch_all(&state.db).await?
    } else {
        sqlx::query_as("select b.id,b.created_at,jsonb_build_object('id',b.id,'resourceId',b.resource_id,'userId',b.booker_id,'startsAt',b.starts_at,'endsAt',b.ends_at,'seats',b.seats,'status',b.status,'createdAt',b.created_at,'cancelledAt',b.cancelled_at) from booking_bookings b where ($1::text is null or b.status=$1) and ($2::uuid is null or b.resource_id=$2) and ($3::uuid is null or b.booker_id=$3) and ($4::timestamptz is null or (b.created_at,b.id)<($4,$5)) order by b.created_at desc,b.id desc limit $6")
        .bind(status).bind(resource).bind(user).bind(at).bind(id).bind(limit+1).fetch_all(&state.db).await?
    };
    let more = rows.len() as i64 > limit;
    let mut rows = rows;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last()
            .map(|r| shared::encode_cursor(r.1, r.0))
            .transpose()?
    } else {
        None
    };
    Ok(Json(
        json!({"data":rows.into_iter().map(|r|r.2).collect::<Vec<_>>(),"meta":{"nextCursor":next}}),
    ))
}
pub(crate) async fn teams(
    State(s): State<AppState>,
    AdminViewer(_): AdminViewer,
    q: Query<List>,
) -> AppResult<Json<Value>> {
    page(&s, q.0, true).await
}
pub(crate) async fn bookings(
    State(s): State<AppState>,
    AdminViewer(_): AdminViewer,
    q: Query<List>,
) -> AppResult<Json<Value>> {
    page(&s, q.0, false).await
}
pub(crate) async fn team(
    State(s): State<AppState>,
    AdminViewer(_): AdminViewer,
    Path(raw): Path<String>,
) -> AppResult<Json<Value>> {
    let id = shared::parse_id(&raw)?;
    let team:Option<Value>=sqlx::query_scalar("select jsonb_build_object('id',id,'name',name,'slug',slug,'createdAt',created_at) from teams where id=$1 and deleted_at is null").bind(id).fetch_optional(&s.db).await?;
    let team = team.ok_or_else(AppError::not_found)?;
    let members:Vec<Value>=sqlx::query_scalar("select jsonb_build_object('userId',m.user_id,'displayName',u.display_name,'email',u.email::text,'role',m.role,'joinedAt',m.joined_at) from team_members m join users u on u.id=m.user_id where m.team_id=$1 and u.deleted_at is null order by m.joined_at,m.user_id limit 500").bind(id).fetch_all(&s.db).await?;
    Ok(Json(json!({"data":{"team":team,"members":members}})))
}
async fn rate(s: &AppState, v: &Viewer, m: &RequestMeta, kind: &str) -> AppResult<()> {
    enforce_rate_limit(
        &s.db,
        &format!("admin:{kind}:ip:{}", m.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    enforce_rate_limit(
        &s.db,
        &format!("admin:{kind}:user:{}", v.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Transfer {
    user_id: Uuid,
}
pub(crate) async fn transfer(
    State(s): State<AppState>,
    AdminViewer(v): AdminViewer,
    m: RequestMeta,
    Path(raw): Path<String>,
    JsonBody(input): JsonBody<Transfer>,
) -> AppResult<Json<Value>> {
    let id = shared::parse_id(&raw)?;
    rate(&s, &v, &m, "teams").await?;
    let mut tx = s.db.begin().await?;
    admin_security::require_step_up(&mut tx, &s, &v).await?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("select id from teams where id=$1 and deleted_at is null for update")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    exists.ok_or_else(AppError::not_found)?;
    let target:Option<String>=sqlx::query_scalar("select m.role from team_members m join users u on u.id=m.user_id where m.team_id=$1 and m.user_id=$2 and u.deleted_at is null and u.status='active' for update of m,u").bind(id).bind(input.user_id).fetch_optional(&mut *tx).await?;
    let target = target.ok_or_else(AppError::not_found)?;
    let owners: Vec<Uuid> = sqlx::query_scalar(
        "select user_id from team_members where team_id=$1 and role='owner' for update",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    if owners.len() != 1 {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "This team needs an owner before it can be transferred.",
        ));
    }
    let old = owners[0];
    if old != input.user_id {
        sqlx::query("update team_members set role='admin' where team_id=$1 and user_id=$2")
            .bind(id)
            .bind(old)
            .execute(&mut *tx)
            .await?;
        sqlx::query("update team_members set role='owner' where team_id=$1 and user_id=$2")
            .bind(id)
            .bind(input.user_id)
            .execute(&mut *tx)
            .await?;
        audit::audit_before_after(
            &mut tx,
            &m,
            &v,
            "admin.team.transfer",
            ("team", &id.to_string()),
            json!({"ownerId":old,"targetRole":target}),
            json!({"ownerId":input.user_id}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"data":{"id":id,"ownerId":input.user_id}})))
}
pub(crate) async fn cancel(
    State(s): State<AppState>,
    AdminViewer(v): AdminViewer,
    m: RequestMeta,
    Path(raw): Path<String>,
) -> AppResult<Json<Value>> {
    let id = shared::parse_id(&raw)?;
    rate(&s, &v, &m, "bookings").await?;
    let mut tx = s.db.begin().await?;
    admin_security::require_step_up(&mut tx, &s, &v).await?;
    let resource: Option<Uuid> =
        sqlx::query_scalar("select resource_id from booking_bookings where id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let resource = resource.ok_or_else(AppError::not_found)?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("booking:resource:{resource}"))
        .execute(&mut *tx)
        .await?;
    let row: Option<(String, time::OffsetDateTime)> =
        sqlx::query_as("select status,starts_at from booking_bookings where id=$1 for update")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let (status, starts) = row.ok_or_else(AppError::not_found)?;
    if status != "cancelled" {
        if starts <= time::OffsetDateTime::now_utc() {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "This booking has already started, so it can't be cancelled.",
            ));
        }
        sqlx::query(
            "update booking_bookings set status='cancelled',cancelled_at=now() where id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        audit::audit_before_after(
            &mut tx,
            &m,
            &v,
            "admin.booking.cancel",
            ("booking", &id.to_string()),
            json!({"status":status,"resourceId":resource}),
            json!({"status":"cancelled","resourceId":resource}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"data":{"id":id,"status":"cancelled"}})))
}
