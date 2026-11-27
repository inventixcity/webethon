use crate::{
    defaults, idempotency, query,
    registry::{CreateAccess, Entity, EntityRegistry},
    service::{self, Record},
};
use axum::{
    Extension, Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use kernel::extract::{Json as JsonBody, Path};
use kernel::{AppError, AppResult, AppState, ErrorCode, request::RequestMeta, viewer::Viewer};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

fn entity<'a>(reg: &'a EntityRegistry, name: &str) -> AppResult<&'a Entity> {
    reg.entities.get(name).ok_or_else(AppError::not_found)
}
fn visibility(value: Option<&str>, def: &crate::registry::EntityDefinition) -> AppResult<String> {
    match value.unwrap_or("private") {
        "private" => Ok("private".into()),
        "public" if def.allow_public => Ok("public".into()),
        _ => Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please check the highlighted fields.",
        )
        .with_details(json!([{"path":"visibility","message":"Choose an allowed visibility."}]))),
    }
}
fn version(headers: &HeaderMap, required: bool) -> AppResult<Option<i32>> {
    let Some(v) = headers.get("if-match") else {
        return if required {
            Err(AppError::new(
                ErrorCode::PreconditionRequired,
                "Please provide If-Match.",
            ))
        } else {
            Ok(None)
        };
    };
    let v = v
        .to_str()
        .map_err(|_| AppError::bad_request("Invalid If-Match."))?;
    let n = v
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(v);
    let n: i32 = n
        .parse()
        .map_err(|_| AppError::bad_request("Invalid If-Match."))?;
    if n < 1 {
        return Err(AppError::bad_request("Invalid If-Match."));
    }
    Ok(Some(n))
}
async fn entities(Extension(reg): Extension<Arc<EntityRegistry>>) -> Json<Value> {
    Json(
        json!({"data":reg.entities.iter().map(|(name,e)| {let mut v=serde_json::to_value(&e.definition).unwrap_or(Value::Null); if let Some(o)=v.as_object_mut(){o.insert("name".into(),json!(name));o.remove("maxPerOwner");} v}).collect::<Vec<_>>() }),
    )
}
async fn list(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    let e = entity(&reg, &name)?;
    let q = query::parse(raw.as_deref(), &e.definition)?;
    Ok(Json(
        service::list(&state.db, &name, &e.definition, viewer.as_ref(), q).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    data: Value,
    visibility: Option<String>,
    team_id: Option<Uuid>,
}
pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path(name): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
    JsonBody(raw): JsonBody<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    // Reuse the shared DTO rejection while retaining the exact value for idempotency.
    let request = axum::http::Request::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
            serde_json::to_vec(&raw).map_err(AppError::internal)?,
        ))
        .map_err(AppError::internal)?;
    let JsonBody(input) =
        <JsonBody<Create> as axum::extract::FromRequest<AppState>>::from_request(request, &state)
            .await?;
    // Preserve validation before an idempotency replay.
    prepare_create(
        &reg,
        &viewer,
        &name,
        input.data.clone(),
        input.visibility.as_deref(),
        CreatePolicy::for_team(input.team_id),
    )?;
    if let Some(team) = input.team_id {
        teams::require_role(&state.db, team, &viewer, teams::TeamRole::Member).await?;
        if input.visibility.as_deref() == Some("public") {
            return Err(AppError::bad_request("Team records must be private."));
        }
    }
    let key = idempotency::key(&headers)?;
    let hash = idempotency::hash(&name, &raw)?;
    let mut tx = state.db.begin().await?;
    if let Some(team) = input.team_id {
        teams::require_role_tx(&mut tx, team, &viewer, teams::TeamRole::Member).await?;
    }
    if let Some(k) = &key
        && let Some(response) = idempotency::reserve(&mut tx, viewer.id, k, &hash).await?
    {
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(response)));
    }
    let record = create_target_in_tx(
        &mut tx,
        &reg,
        &viewer,
        &meta,
        &name,
        input.data,
        input.visibility.as_deref(),
        input.team_id,
    )
    .await?;
    let response = json!({"data":record});
    if let Some(k) = key {
        sqlx::query(
            "update idempotency_keys set status=201,response=$3 where owner_id=$1 and key=$2",
        )
        .bind(viewer.id)
        .bind(k)
        .bind(&response)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// Which create rule applies. Team creates are gated by team role (checked by the caller), not by the
/// entity's personal `create` rule: a Member may add team rows even when personal rows of that
/// entity are admin-only.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreatePolicy {
    Personal,
    Team,
}
impl CreatePolicy {
    fn for_team(team: Option<Uuid>) -> Self {
        if team.is_some() {
            Self::Team
        } else {
            Self::Personal
        }
    }
}

fn prepare_create(
    reg: &EntityRegistry,
    viewer: &Viewer,
    name: &str,
    mut data: Value,
    vis: Option<&str>,
    policy: CreatePolicy,
) -> AppResult<(Value, String)> {
    check_create_access(reg, viewer, name, policy)?;
    let e = entity(reg, name)?;
    let vis = visibility(vis, &e.definition)?;
    defaults::apply(&e.definition.schema, &mut data);
    defaults::trim(&mut data);
    service::validate(e, &data)?;
    Ok((data, vis))
}

pub(crate) fn prepare_create_data(
    reg: &EntityRegistry,
    viewer: &Viewer,
    name: &str,
    data: Value,
) -> AppResult<Value> {
    prepare_create(reg, viewer, name, data, None, CreatePolicy::Personal).map(|(data, _)| data)
}

pub(crate) async fn personal_capacity(
    db: &sqlx::PgPool,
    reg: &EntityRegistry,
    viewer: &Viewer,
    name: &str,
) -> AppResult<Option<usize>> {
    check_create_access(reg, viewer, name, CreatePolicy::Personal)?;
    let max = entity(reg, name)?.definition.max_per_owner;
    let count: i64 = sqlx::query_scalar("select count(*) from records where entity=$1 and owner_id=$2 and team_id is null and deleted_at is null")
        .bind(name).bind(viewer.id).fetch_one(db).await?;
    Ok(Some(
        usize::try_from(max.saturating_sub(count as u64)).unwrap_or(usize::MAX),
    ))
}

async fn reserve_capacity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reg: &EntityRegistry,
    viewer: &Viewer,
    name: &str,
    team_id: Option<Uuid>,
    amount: usize,
) -> AppResult<()> {
    let d = &entity(reg, name)?.definition;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "{}:{}:{}",
            viewer.id,
            name,
            team_id.map_or_else(|| "personal".to_owned(), |id| id.to_string())
        ))
        .execute(&mut **tx)
        .await?;
    let count: i64 = sqlx::query_scalar("select count(*) from records where entity=$1 and owner_id=$2 and team_id is not distinct from $3 and deleted_at is null")
        .bind(name).bind(viewer.id).bind(team_id).fetch_one(&mut **tx).await?;
    if (count as u64).saturating_add(amount as u64) > d.max_per_owner {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "You have reached the limit.",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_many_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reg: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    name: &str,
    rows: Vec<Value>,
    vis: Option<&str>,
) -> AppResult<Vec<Value>> {
    if rows.is_empty() || rows.len() > 100 {
        return Err(AppError::bad_request("Provide between 1 and 100 records."));
    }
    let mut prepared = Vec::with_capacity(rows.len());
    let mut visibility = String::new();
    for row in rows {
        let (data, v) = prepare_create(reg, viewer, name, row, vis, CreatePolicy::Personal)?;
        prepared.push(data);
        visibility = v;
    }
    reserve_capacity(tx, reg, viewer, name, None, prepared.len()).await?;
    let records: Vec<Record> = sqlx::query_as("insert into records(entity,owner_id,data,visibility,team_id) select $1,$2,value,$4,null from jsonb_array_elements($3::jsonb) returning id,entity,owner_id,team_id,admin_hidden_at,data,visibility,version,created_at,updated_at")
        .bind(name).bind(viewer.id).bind(Value::Array(prepared)).bind(visibility).fetch_all(&mut **tx).await?;
    let ids: Vec<String> = records.iter().map(|r| r.id.to_string()).collect();
    sqlx::query("insert into audit_log (actor_id, action, target_type, target_id, ip, user_agent, request_id, meta) select $1,'record.create','record',id,$2,$3,$4,$5 from unnest($6::text[]) as id")
        .bind(viewer.id).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({})).bind(ids).execute(&mut **tx).await?;
    records.into_iter().map(|r| r.json()).collect()
}

pub(crate) fn check_create_access(
    reg: &EntityRegistry,
    viewer: &Viewer,
    name: &str,
    policy: CreatePolicy,
) -> AppResult<()> {
    let e = entity(reg, name)?;
    if policy == CreatePolicy::Personal && e.definition.create == CreateAccess::Admin {
        viewer.require_admin()?;
    }
    Ok(())
}

async fn audit_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    meta: &RequestMeta,
    viewer: &Viewer,
    action: &str,
    id: Uuid,
) -> AppResult<()> {
    sqlx::query("insert into audit_log (actor_id, action, target_type, target_id, ip, user_agent, request_id, meta) values ($1,$2,'record',$3,$4,$5,$6,$7)")
        .bind(viewer.id).bind(action).bind(id.to_string()).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({})).execute(&mut **tx).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reg: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    name: &str,
    data: Value,
    vis: Option<&str>,
) -> AppResult<Value> {
    create_target_in_tx(tx, reg, viewer, meta, name, data, vis, None).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_target_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reg: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    name: &str,
    data: Value,
    vis: Option<&str>,
    team_id: Option<Uuid>,
) -> AppResult<Value> {
    if let Some(team) = team_id {
        teams::require_role_tx(tx, team, viewer, teams::TeamRole::Member).await?;
        if vis == Some("public") {
            return Err(AppError::bad_request("Team records must be private."));
        }
    }
    let (data, vis) = prepare_create(
        reg,
        viewer,
        name,
        data,
        vis,
        CreatePolicy::for_team(team_id),
    )?;
    reserve_capacity(tx, reg, viewer, name, team_id, 1).await?;
    let record: Record = sqlx::query_as("insert into records(entity,owner_id,data,visibility,team_id) values($1,$2,$3,$4,$5) returning id,entity,owner_id,team_id,admin_hidden_at,data,visibility,version,created_at,updated_at").bind(name).bind(viewer.id).bind(data).bind(vis).bind(team_id).fetch_one(&mut **tx).await?;
    audit_tx(tx, meta, viewer, "record.create", record.id).await?;
    record.json()
}

pub(crate) async fn read(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path((name, id)): Path<(String, String)>,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    let e = entity(&reg, &name)?;
    let id = Uuid::parse_str(&id).map_err(|_| AppError::not_found())?;
    let r = service::get(&state.db, &name, id).await?;
    if !r
        .can_read(&state.db, &e.definition, viewer.as_ref())
        .await?
    {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({"data":r.json()?})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Patch {
    pub(crate) data: Option<Value>,
    pub(crate) visibility: Option<String>,
}
pub(crate) async fn patch(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path((name, id)): Path<(String, String)>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
    JsonBody(input): JsonBody<Patch>,
) -> AppResult<Json<Value>> {
    let expected = version(&headers, true)?.ok_or_else(|| AppError::internal("missing version"))?;
    let id = Uuid::parse_str(&id).map_err(|_| AppError::not_found())?;
    let mut tx = state.db.begin().await?;
    let record = patch_in_tx(
        &mut tx,
        &reg,
        &viewer,
        &meta,
        &name,
        id,
        input.data,
        input.visibility.as_deref(),
        expected,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":record})))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn patch_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reg: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    name: &str,
    id: Uuid,
    part: Option<Value>,
    new_visibility: Option<&str>,
    expected: i32,
) -> AppResult<Value> {
    let e = entity(reg, name)?;
    let r: Record = sqlx::query_as("select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.entity=$1 and r.id=$2 and r.deleted_at is null and u.deleted_at is null for update of r")
        .bind(name).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(AppError::not_found)?;
    authorize_tx(tx, &r, &e.definition, viewer).await?;
    if r.version != expected {
        return Err(
            AppError::new(ErrorCode::VersionConflict, "This record has changed.")
                .with_details(json!({"currentVersion":r.version})),
        );
    }
    let mut data = r.data;
    let mut touched: Vec<String> = Vec::new();
    if let Some(mut part) = part {
        // Trim only what this request sends. Stored text it does not touch stays as it was saved.
        defaults::trim(&mut part);
        let patch = part.as_object().ok_or_else(|| {
            AppError::new(
                ErrorCode::ValidationFailed,
                "Please check the highlighted fields.",
            )
            .with_details(json!([{"path":"data","message":"Must be an object."}]))
        })?;
        touched = patch.keys().cloned().collect();
        data.as_object_mut()
            .ok_or_else(|| AppError::internal("record data is not an object"))?
            .extend(patch.clone());
    }
    service::validate_patch(e, &data, &touched)?;
    if r.admin_hidden_at.is_some() && new_visibility == Some("public") {
        return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please check the highlighted fields.",
        )
        .with_details(json!([{"path":"visibility","message":"This record is hidden."}])));
    }
    let vis = if let Some(v) = new_visibility {
        visibility(Some(v), &e.definition)?
    } else {
        r.visibility
    };
    if r.team_id.is_some() && vis == "public" {
        return Err(AppError::bad_request("Team records must be private."));
    }
    let updated: Record = sqlx::query_as("update records set data=$1,visibility=$2,version=version+1 where id=$3 and version=$4 and deleted_at is null returning id,entity,owner_id,team_id,admin_hidden_at,data,visibility,version,created_at,updated_at").bind(data).bind(vis).bind(id).bind(expected).fetch_one(&mut **tx).await?;
    audit_tx(tx, meta, viewer, "record.update", id).await?;
    updated.json()
}

async fn authorize_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    r: &Record,
    def: &crate::registry::EntityDefinition,
    viewer: &Viewer,
) -> AppResult<()> {
    if let Some(team) = r.team_id {
        let role = teams::require_role_tx(tx, team, viewer, teams::TeamRole::Viewer).await?;
        // Hidden team rows look missing to everyone except the owner and global admins.
        if !r.hidden_visible(Some(viewer)) {
            return Err(AppError::not_found());
        }
        if role < teams::TeamRole::Admin
            && (role < teams::TeamRole::Member || r.owner_id != viewer.id)
        {
            return Err(AppError::forbidden());
        }
    } else {
        if !r.readable(def, Some(viewer)) {
            return Err(AppError::not_found());
        }
        if !r.writable(def, viewer) {
            return Err(AppError::forbidden());
        }
    }
    Ok(())
}

async fn delete(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path((name, id)): Path<(String, String)>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let e = entity(&reg, &name)?;
    let expected = version(&headers, false)?;
    let id = Uuid::parse_str(&id).map_err(|_| AppError::not_found())?;
    let mut tx = state.db.begin().await?;
    let r: Record = sqlx::query_as("select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.entity=$1 and r.id=$2 and r.deleted_at is null and u.deleted_at is null for update of r")
        .bind(&name).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    authorize_tx(&mut tx, &r, &e.definition, &viewer).await?;
    if expected.is_some_and(|v| v != r.version) {
        return Err(
            AppError::new(ErrorCode::VersionConflict, "This record has changed.")
                .with_details(json!({"currentVersion":r.version})),
        );
    }
    sqlx::query("update records set deleted_at=now(),version=version+1 where id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit_tx(&mut tx, &meta, &viewer, "record.delete", id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub fn router(registry: Arc<EntityRegistry>) -> Router<AppState> {
    Router::new()
        .merge(crate::account::router())
        .route("/entities", get(entities))
        .route("/entities/{entity}", get(list).post(create))
        .route(
            "/entities/{entity}/{id}",
            get(read).patch(patch).delete(delete),
        )
        .layer(Extension(registry))
}
