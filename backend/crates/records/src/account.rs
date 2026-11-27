use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, header},
    routing::get,
};
use kernel::extract::Json as JsonBody;
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    request::RequestMeta,
    security::{AuditEntry, audit},
    session,
    viewer::Viewer,
};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new().route("/me", get(read).patch(update).delete(delete))
}
async fn read(State(state): State<AppState>, viewer: Viewer) -> AppResult<Json<Value>> {
    let row: (uuid::Uuid, String, String, Option<String>, String, time::OffsetDateTime) = sqlx::query_as("select id, email::text, display_name, avatar_url, role, created_at from users where id=$1 and deleted_at is null")
        .bind(viewer.id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    Ok(Json(
        json!({"data": {"id": row.0, "email": row.1, "displayName": row.2, "avatarUrl": row.3, "role": if viewer.is_admin() {"admin"} else {&row.4}, "createdAt": row.5.format(&time::format_description::well_known::Rfc3339).map_err(AppError::internal)?}}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    display_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    avatar_url: Option<Option<String>>,
}
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":message}]))
}
fn guard_demo(state: &AppState, viewer: &Viewer) -> AppResult<()> {
    if state
        .config
        .demo_email
        .as_ref()
        .is_some_and(|email| email.eq_ignore_ascii_case(&viewer.email))
    {
        return Err(AppError::new(
            ErrorCode::Forbidden,
            "The demo account cannot be changed.",
        ));
    }
    Ok(())
}
async fn update(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    JsonBody(input): JsonBody<Input>,
) -> AppResult<Json<Value>> {
    guard_demo(&state, &viewer)?;
    let name = input.display_name.map(|name| name.trim().to_owned());
    if let Some(name) = &name
        && (name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control))
    {
        return Err(invalid(
            "displayName",
            "Use 1 to 120 characters without control characters.",
        ));
    }
    if let Some(Some(url)) = &input.avatar_url
        && (url.len() > 2048
            || reqwest::Url::parse(url)
                .ok()
                .filter(|url| url.scheme() == "https" && url.host_str().is_some())
                .is_none())
    {
        return Err(invalid("avatarUrl", "Use a valid HTTPS URL."));
    }
    let result = sqlx::query("update users set display_name=coalesce($2,display_name), avatar_url=case when $3 then $4 else avatar_url end where id=$1 and deleted_at is null")
        .bind(viewer.id).bind(name).bind(input.avatar_url.is_some()).bind(input.avatar_url.flatten()).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "profile.update",
            actor_id: Some(viewer.id),
            target_type: Some("user"),
            target_id: Some(viewer.id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    read(State(state), viewer).await
}
async fn delete(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<(
    StatusCode,
    [(header::HeaderName, axum::http::HeaderValue); 1],
)> {
    guard_demo(&state, &viewer)?;
    let mut tx = state.db.begin().await?;
    let result =
        sqlx::query("update users set deleted_at=now() where id=$1 and deleted_at is null")
            .bind(viewer.id)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    sqlx::query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null")
        .bind(viewer.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "account.delete",
            actor_id: Some(viewer.id),
            target_type: Some("user"),
            target_id: Some(viewer.id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session::clear_cookie(&state.config))],
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod extractor_rejection_tests {
    use super::*;
    use axum::extract::FromRequest;
    #[tokio::test]
    async fn dto_rejections_use_shared_errors() {
        for (body, code, path) in [
            ("{", kernel::ErrorCode::BadRequest, ""),
            (
                "{\"unexpected\":1}",
                kernel::ErrorCode::ValidationFailed,
                "unexpected",
            ),
        ] {
            let request = axum::http::Request::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            let error = match <JsonBody<Input> as FromRequest<()>>::from_request(request, &()).await
            {
                Ok(_) => panic!("invalid input accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, code);
            if !path.is_empty() {
                assert_eq!(error.details.unwrap()[0]["path"], path);
            }
        }
    }
}
