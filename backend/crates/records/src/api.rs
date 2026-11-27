//! Shared record operations use the same validation and mutation paths as HTTP.
use crate::{registry::EntityRegistry, routes};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, HeaderValue},
};
use kernel::extract::{Json as JsonBody, Path};
use kernel::{AppError, AppResult, AppState, request::RequestMeta, viewer::Viewer};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

fn raw(value: Value) -> AppResult<Value> {
    value
        .get("data")
        .cloned()
        .ok_or_else(|| AppError::internal("missing record response"))
}

/// Apply personal creation policy, defaults and validation without database writes.
pub fn prepare_create_data(
    registry: &EntityRegistry,
    viewer: &Viewer,
    entity: &str,
    data: Value,
) -> AppResult<Value> {
    routes::prepare_create_data(registry, viewer, entity, data)
}

/// Return a snapshot of remaining personal quota.
pub async fn personal_capacity(
    db: &sqlx::PgPool,
    registry: &EntityRegistry,
    viewer: &Viewer,
    entity: &str,
) -> AppResult<Option<usize>> {
    routes::personal_capacity(db, registry, viewer, entity).await
}

/// Create a bounded batch in the caller's transaction.
#[allow(clippy::too_many_arguments)]
pub async fn create_many_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    rows: Vec<Value>,
    visibility: Option<&str>,
) -> AppResult<Vec<Value>> {
    routes::create_many_in_tx(tx, registry, viewer, meta, entity, rows, visibility).await
}

/// Check the personal creation policy independently of any particular row.
pub fn check_create_access(
    registry: &EntityRegistry,
    viewer: &Viewer,
    entity: &str,
) -> AppResult<()> {
    routes::check_create_access(registry, viewer, entity, routes::CreatePolicy::Personal)
}

pub async fn read(
    state: &AppState,
    registry: &EntityRegistry,
    viewer: Option<&Viewer>,
    entity: &str,
    id: Uuid,
) -> AppResult<Value> {
    let Json(value) = routes::read(
        State(state.clone()),
        Extension(Arc::new(registry.clone())),
        Path((entity.to_owned(), id.to_string())),
        viewer.cloned(),
    )
    .await?;
    raw(value)
}

pub async fn create(
    state: &AppState,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    data: Value,
    visibility: Option<&str>,
) -> AppResult<Value> {
    let (_, Json(value)) = routes::create(
        State(state.clone()),
        Extension(Arc::new(registry.clone())),
        Path(entity.to_owned()),
        viewer.clone(),
        meta.clone(),
        HeaderMap::new(),
        JsonBody(json!({"data":data,"visibility":visibility})),
    )
    .await?;
    raw(value)
}

#[allow(clippy::too_many_arguments)]
pub async fn update(
    state: &AppState,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    id: Uuid,
    data: Value,
    version: i32,
) -> AppResult<Value> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "if-match",
        HeaderValue::from_str(&version.to_string()).map_err(AppError::internal)?,
    );
    let Json(value) = routes::patch(
        State(state.clone()),
        Extension(Arc::new(registry.clone())),
        Path((entity.to_owned(), id.to_string())),
        viewer.clone(),
        meta.clone(),
        headers,
        JsonBody(routes::Patch {
            data: Some(data),
            visibility: None,
        }),
    )
    .await?;
    raw(value)
}

/// Create a record as part of the caller's transaction. The caller controls commit or rollback.
#[allow(clippy::too_many_arguments)]
pub async fn create_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    data: Value,
    visibility: Option<&str>,
) -> AppResult<Value> {
    routes::create_in_tx(tx, registry, viewer, meta, entity, data, visibility).await
}

/// Patch record data as part of the caller's transaction, without changing visibility.
#[allow(clippy::too_many_arguments)]
pub async fn update_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    id: Uuid,
    data: Value,
    version: i32,
) -> AppResult<Value> {
    routes::patch_in_tx(
        tx,
        registry,
        viewer,
        meta,
        entity,
        id,
        Some(data),
        None,
        version,
    )
    .await
}

/// Create a private team record within the caller's transaction.
#[allow(clippy::too_many_arguments)]
pub async fn create_in_team_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    registry: &EntityRegistry,
    viewer: &Viewer,
    meta: &RequestMeta,
    entity: &str,
    data: Value,
    visibility: Option<&str>,
    team_id: Uuid,
) -> AppResult<Value> {
    routes::create_target_in_tx(
        tx,
        registry,
        viewer,
        meta,
        entity,
        data,
        visibility,
        Some(team_id),
    )
    .await
}
