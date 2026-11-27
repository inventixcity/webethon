use axum::{
    Extension, Json, Router,
    extract::{FromRequestParts, State},
    routing::{get, post},
};
use kernel::extract::Json as JsonBody;
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer,
    request::RequestMeta,
    security::{self as rate_security, limits},
};
pub use security::require_step_up;
use serde::Deserialize;
use serde_json::{Value, json};

mod audit;
mod audit_log;
mod comments;
mod content;
mod domains;
mod files;
mod management;
mod payments;
use ::payments as payments_catalog;
mod security;
mod shared;
mod users;

struct AdminViewer(Viewer);
impl FromRequestParts<AppState> for AdminViewer {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let viewer = Viewer::from_request_parts(parts, state).await?;
        viewer.require_admin()?;
        Ok(Self(viewer))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StepUp {
    password: String,
    code: Option<String>,
}
async fn step_up(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    JsonBody(input): JsonBody<StepUp>,
) -> AppResult<Json<Value>> {
    viewer.require_admin()?;
    rate_security::enforce_rate_limit(
        &state.db,
        &format!("admin:stepup:ip:{}", meta.ip),
        limits::CODE_PER_IP,
    )
    .await?;
    rate_security::enforce_rate_limit(
        &state.db,
        &format!("admin:stepup:user:{}", viewer.id),
        limits::CODE_PER_ACCOUNT,
    )
    .await?;
    if input.password.is_empty()
        || input.password.chars().count() > 128
        || input.code.as_ref().is_some_and(|c| c.len() > 64)
    {
        return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please check your credentials.",
        )
        .with_details(json!([{"path":"password","message":"Please check your credentials."}])));
    }
    let mut tx = state.db.begin().await?;
    auth::admin_reauthenticate(&state, &mut tx, &viewer, input.password, input.code).await?;
    let expires: time::OffsetDateTime = sqlx::query_scalar("insert into admin_step_up(session_id, expires_at, password_changed_at, password_hash_snapshot, mfa_snapshot) select $1, clock_timestamp()+interval '10 minutes', u.password_changed_at, digest(coalesce(u.password_hash,''),'sha256'), (select digest(secret_ciphertext || secret_nonce || convert_to(enabled_at::text,'UTF8'),'sha256') from mfa_totp where user_id=u.id and enabled_at is not null) from users u where u.id=$2 on conflict(session_id) do update set expires_at=excluded.expires_at, password_changed_at=excluded.password_changed_at, password_hash_snapshot=excluded.password_hash_snapshot, mfa_snapshot=excluded.mfa_snapshot returning expires_at")
        .bind(viewer.session_id).bind(viewer.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"data":{"expiresAt":expires.format(&time::format_description::well_known::Rfc3339).map_err(AppError::internal)?}}),
    ))
}
async fn overview(
    State(state): State<AppState>,
    AdminViewer(viewer): AdminViewer,
) -> AppResult<Json<Value>> {
    viewer.require_admin()?;
    let mut data: Value = sqlx::query_scalar(r#"select jsonb_build_object(
        'users',(select count(*) from users where deleted_at is null),
        'activeSessions',(select count(*) from sessions s join users u on u.id=s.user_id where s.revoked_at is null and s.expires_at>clock_timestamp() and u.status='active' and u.deleted_at is null),
        'signupsPerDay',coalesce((select jsonb_agg(row_to_json(t) order by t.day) from (select (created_at at time zone 'UTC')::date::text as day,count(*) as count from users where created_at >= (date_trunc('day', now() at time zone 'UTC') - interval '29 days') at time zone 'UTC' group by 1) t),'[]'::jsonb),
        'aiUsage',(select jsonb_build_object('requests',coalesce(sum(requests),0),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0)) from ai_usage),
        'revenue',coalesce((select jsonb_agg(row_to_json(t)) from (select currency,sum(amount_cents) as "amountCents" from purchases group by currency) t),'[]'::jsonb),
        'auditEvents',(select count(*) from audit_log), 'httpErrorRate',null,'http429Rate',null)"#).fetch_one(&state.db).await?;
    // Rates are fractions over the current and preceding 59 UTC minute buckets;
    // no observed requests yields zero for both rates.
    let stats = kernel::telemetry::stats(&state.db, 60).await?;
    data["httpErrorRate"] = json!(rate(stats.errors, stats.total));
    data["http429Rate"] = json!(rate(stats.rate_limited, stats.total));
    Ok(Json(json!({"data":data})))
}
fn rate(count: i64, total: i64) -> f64 {
    if total == 0 {
        0.0
    } else {
        count as f64 / total as f64
    }
}
async fn system(
    State(state): State<AppState>,
    AdminViewer(viewer): AdminViewer,
) -> AppResult<Json<Value>> {
    viewer.require_admin()?;
    let migrations: i64 = sqlx::query_scalar("select count(*) from _sqlx_migrations where success")
        .fetch_one(&state.db)
        .await?;
    let rates: Value = sqlx::query_scalar("select jsonb_build_object('activeKeys',count(*),'totalHits',coalesce(sum(hits),0)) from rate_limits where window_start>clock_timestamp()-interval '1 hour'").fetch_one(&state.db).await?;
    Ok(Json(
        json!({"data":{"database":"healthy","appliedMigrations":migrations,"config":{"production":state.config.is_production(),"secureCookies":state.config.secure_cookies,"breachCheck":state.config.breach_check,"googleEnabled":state.config.google.is_some(),"githubEnabled":state.config.github.is_some(),"emailConfigured":state.config.resend_api_key.is_some() || state.config.smtp_url.is_some()},"rateLimits":rates}}),
    ))
}
pub fn router() -> Router<AppState> {
    let path = std::env::var("PRODUCTS_PATH")
        .ok()
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "config/products.json".into());
    router_with_catalog(payments_catalog::Catalog::load(&path))
}

/// Construct an admin router with a validated product catalog.
pub fn router_with_catalog(catalog: payments_catalog::Catalog) -> Router<AppState> {
    Router::new()
        .route("/payments/purchases", get(payments::purchases))
        .route("/payments/entitlements", get(payments::entitlements))
        .route("/payments/entitlements/grant", post(payments::grant))
        .route("/payments/entitlements/revoke", post(payments::revoke))
        .route("/places", get(management::places))
        .route("/places/{id}/hide", post(management::hide))
        .route("/places/{id}/unhide", post(management::unhide))
        .route("/jobs", get(management::jobs))
        .route("/jobs/{id}/retry", post(management::retry))
        .route("/jobs/{id}/cancel", post(management::cancel))
        .route("/teams", get(domains::teams))
        .route("/teams/{id}", get(domains::team))
        .route("/teams/{id}/transfer", post(domains::transfer))
        .route("/bookings", get(domains::bookings))
        .route("/bookings/{id}/cancel", post(domains::cancel))
        .route("/step-up", post(step_up))
        .route("/overview", get(overview))
        .route("/stats", get(overview))
        .route("/system", get(system))
        .route("/audit", get(audit_log::list))
        .route("/audit/export", get(audit_log::export))
        .route("/content", get(content::list))
        .route("/content/{entity}/{id}", get(content::detail))
        .route("/content/{entity}/{id}/hide", post(content::hide))
        .route("/content/{entity}/{id}/unhide", post(content::unhide))
        .route("/content/{entity}/{id}/delete", post(content::delete))
        .route("/content/{entity}/{id}/restore", post(content::restore))
        .route("/files", get(files::list))
        .route("/files/{id}", get(files::detail).delete(files::delete))
        .route("/comments", get(comments::list))
        .route("/comments/{id}/hide", post(comments::hide))
        .route("/comments/{id}/unhide", post(comments::unhide))
        .route("/comments/{id}/delete", post(comments::delete))
        .route("/users", get(users::list).post(users::create))
        .route("/users/{id}", get(users::detail))
        .route("/users/{id}/suspend", post(users::suspend))
        .route("/users/{id}/unsuspend", post(users::unsuspend))
        .route("/users/{id}/role", post(users::role))
        .route("/users/{id}/sessions/revoke", post(users::revoke))
        .route("/users/{id}/mfa/reset", post(users::reset_mfa))
        .route("/users/{id}/delete", post(users::delete))
        .route("/users/{id}/restore", post(users::restore))
        .route("/users/{id}/verification/resend", post(users::resend))
        .layer(Extension(std::sync::Arc::new(catalog)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use kernel::{config::Config, email::LogSender};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn rates_are_fractions_and_empty_is_zero() {
        assert_eq!(rate(0, 0), 0.0);
        assert_eq!(rate(1, 4), 0.25);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn overview_uses_telemetry(db: sqlx::PgPool) {
        sqlx::query("insert into http_request_stats values (date_trunc('minute', now()), 'GET', '/test', 200, 2), (date_trunc('minute', now()), 'GET', '/test', 429, 1), (date_trunc('minute', now()), 'GET', '/test', 500, 1), (date_trunc('minute', now()) - interval '61 minutes', 'GET', '/test', 500, 9)").execute(&db).await.unwrap();
        let id: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('overview@example.test','admin') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(id).bind(hash.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db,
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let response = router()
            .with_state(state)
            .oneshot(
                Request::get("/overview")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["data"]["httpErrorRate"], 0.25);
        assert_eq!(body["data"]["http429Rate"], 0.25);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn every_route_rejects_non_admin(db: sqlx::PgPool) {
        let id: uuid::Uuid =
            sqlx::query_scalar("insert into users(email) values('user@example.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(id).bind(hash.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db,
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        for (method, path) in [
            ("GET", "/payments/purchases"),
            ("GET", "/payments/entitlements"),
            ("POST", "/payments/entitlements/grant"),
            ("POST", "/payments/entitlements/revoke"),
            ("GET", "/places"),
            ("POST", "/places/not-a-uuid/hide"),
            ("POST", "/places/not-a-uuid/unhide"),
            ("GET", "/jobs"),
            ("POST", "/jobs/not-a-uuid/retry"),
            ("POST", "/jobs/not-a-uuid/cancel"),
            ("GET", "/teams"),
            ("GET", "/teams/not-a-uuid"),
            ("POST", "/teams/not-a-uuid/transfer"),
            ("GET", "/bookings"),
            ("POST", "/bookings/not-a-uuid/cancel"),
            ("POST", "/step-up"),
            ("GET", "/overview"),
            ("GET", "/stats"),
            ("GET", "/system"),
            ("GET", "/audit"),
            ("GET", "/audit/export"),
            ("GET", "/content"),
            ("GET", "/content/bad/not-a-uuid"),
            ("POST", "/content/bad/not-a-uuid/hide"),
            ("POST", "/content/bad/not-a-uuid/unhide"),
            ("POST", "/content/bad/not-a-uuid/delete"),
            ("POST", "/content/bad/not-a-uuid/restore"),
            ("GET", "/files"),
            ("GET", "/files/not-a-uuid"),
            ("DELETE", "/files/not-a-uuid"),
            ("GET", "/comments"),
            ("POST", "/comments/not-a-uuid/hide"),
            ("POST", "/comments/not-a-uuid/unhide"),
            ("POST", "/comments/not-a-uuid/delete"),
            ("GET", "/users"),
            ("GET", "/users/not-a-uuid"),
            ("POST", "/users/not-a-uuid/suspend"),
            ("POST", "/users/not-a-uuid/unsuspend"),
            ("POST", "/users/not-a-uuid/role"),
            ("POST", "/users/not-a-uuid/sessions/revoke"),
            ("POST", "/users/not-a-uuid/mfa/reset"),
            ("POST", "/users/not-a-uuid/delete"),
            ("POST", "/users/not-a-uuid/restore"),
            ("POST", "/users/not-a-uuid/verification/resend"),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap();
            assert_eq!(
                router()
                    .with_state(state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN,
                "{method} {path}"
            );
        }
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn step_up_password_and_overview(db: sqlx::PgPool) {
        use argon2::{
            Argon2, PasswordHasher,
            password_hash::{SaltString, rand_core::OsRng},
        };
        let hash = Argon2::default()
            .hash_password(b"strong-password", &SaltString::generate(&mut OsRng))
            .unwrap()
            .to_string();
        let id: uuid::Uuid = sqlx::query_scalar("insert into users(email,role,password_hash) values('admin-test@example.test','admin',$1) returning id").bind(hash).fetch_one(&db).await.unwrap();
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(id).bind(hash.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db,
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        for (method, path, body, expected) in [
            (
                "POST",
                "/step-up",
                r#"{"password":"wrong"}"#,
                StatusCode::UNAUTHORIZED,
            ),
            (
                "POST",
                "/step-up",
                r#"{"password":"strong-password"}"#,
                StatusCode::OK,
            ),
            ("GET", "/overview", "", StatusCode::OK),
            ("GET", "/stats", "", StatusCode::OK),
            ("GET", "/system", "", StatusCode::OK),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                router()
                    .with_state(state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
    }
}
