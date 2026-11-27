//! Rate limits, the audit log and the cross-site request check.

use std::time::Duration;

use axum::http::{HeaderMap, Method};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{AppError, AppResult, ErrorCode, config::Config, crypto, request::RequestMeta};

#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub limit: i32,
    pub window: Duration,
}

const fn limit(limit: i32, seconds: u64) -> Limit {
    Limit {
        limit,
        window: Duration::from_secs(seconds),
    }
}

/// Ready-made budgets, tuned in one place.
pub mod limits {
    use super::{Limit, limit};
    pub const SIGN_IN_PER_IP: Limit = limit(20, 15 * 60);
    pub const SIGN_IN_PER_ACCOUNT: Limit = limit(8, 15 * 60);
    pub const SIGN_UP_PER_IP: Limit = limit(6, 60 * 60);
    pub const EMAIL_PER_ACCOUNT: Limit = limit(5, 60 * 60);
    pub const EMAIL_PER_IP: Limit = limit(15, 60 * 60);
    pub const CODE_PER_ACCOUNT: Limit = limit(6, 15 * 60);
    pub const CODE_PER_IP: Limit = limit(30, 15 * 60);
    pub const PASSWORD_CHANGE_PER_ACCOUNT: Limit = limit(6, 60 * 60);
    pub const API_READ_PER_SUBJECT: Limit = limit(600, 60);
    pub const API_WRITE_PER_SUBJECT: Limit = limit(120, 60);
}

pub struct RateResult {
    pub allowed: bool,
    pub remaining: i32,
    pub reset_at: OffsetDateTime,
}

/// Counts one hit against a budget shared by every replica. Keys are hashed, so no emails or IPs
/// sit in the table in plain text.
pub async fn rate_limit_hit(db: &PgPool, key: &str, budget: Limit) -> AppResult<RateResult> {
    let hashed = URL_SAFE_NO_PAD.encode(crypto::sha256(key.as_bytes()));
    let seconds = i32::try_from(budget.window.as_secs()).unwrap_or(i32::MAX);
    let (allowed, remaining, reset_at): (bool, i32, OffsetDateTime) =
        sqlx::query_as("select allowed, remaining, reset_at from rate_limit_hit($1, $2, $3)")
            .bind(hashed)
            .bind(budget.limit)
            .bind(seconds)
            .fetch_one(db)
            .await?;
    Ok(RateResult {
        allowed,
        remaining,
        reset_at,
    })
}

/// Like `rate_limit_hit`, but fails with RATE_LIMITED and a Retry-After once the budget is spent.
pub async fn enforce_rate_limit(db: &PgPool, key: &str, budget: Limit) -> AppResult<RateResult> {
    let result = rate_limit_hit(db, key, budget).await?;
    if !result.allowed {
        let wait = (result.reset_at - OffsetDateTime::now_utc())
            .whole_seconds()
            .max(1);
        return Err(AppError::new(
            ErrorCode::RateLimited,
            "Too many attempts. Please wait a little and try again.",
        )
        .retry_after(u64::try_from(wait).unwrap_or(1)));
    }
    Ok(result)
}

/// Clears a budget, e.g. the per-account sign-in counter after a correct password.
pub async fn rate_limit_reset(db: &PgPool, key: &str) -> AppResult<()> {
    let hashed = URL_SAFE_NO_PAD.encode(crypto::sha256(key.as_bytes()));
    sqlx::query("delete from rate_limits where key = $1")
        .bind(hashed)
        .execute(db)
        .await?;
    Ok(())
}

pub struct AuditEntry<'a> {
    pub action: &'a str,
    pub actor_id: Option<Uuid>,
    pub target_type: Option<&'a str>,
    pub target_id: Option<String>,
    /// Small, non-secret facts only. Never passwords, codes, tokens or request bodies.
    pub meta: Value,
}

/// Records a security-relevant event. Never fails the request: a logging problem is only logged.
pub async fn audit(db: &PgPool, request: &RequestMeta, entry: AuditEntry<'_>) {
    let result = sqlx::query(
        "insert into audit_log (actor_id, action, target_type, target_id, ip, user_agent, request_id, meta)
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(&request.ip)
    .bind(&request.user_agent)
    .bind(&request.request_id)
    .bind(entry.meta)
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::error!(action = entry.action, error = %error, "audit write failed");
    }
}

/// Records an audit entry in the caller's transaction so the event and its change commit or roll back together.
pub async fn audit_tx(
    tx: &mut Transaction<'_, Postgres>,
    request: &RequestMeta,
    entry: AuditEntry<'_>,
) -> AppResult<()> {
    sqlx::query(
        "insert into audit_log (actor_id, action, target_type, target_id, ip, user_agent, request_id, meta)
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(&request.ip)
    .bind(&request.user_agent)
    .bind(&request.request_id)
    .bind(entry.meta)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Cross-site request forgery check for cookie-authenticated writes, using headers browsers set
/// themselves. Requests carrying neither header come from non-browser clients, which can't hold a
/// victim's cookies.
pub fn passes_origin_check(config: &Config, method: &Method, headers: &HeaderMap) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    let get = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    if let Some(site) = get("sec-fetch-site")
        && site != "same-origin"
        && site != "none"
    {
        return false;
    }
    match get("origin") {
        None => true,
        Some(origin) => config
            .allowed_origins
            .contains(&origin.trim_end_matches('/').to_ascii_lowercase()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        http::{StatusCode, header},
        response::IntoResponse,
    };

    #[sqlx::test(migrations = "../../migrations")]
    async fn audit_tx_obeys_caller_transaction(db: PgPool) -> AppResult<()> {
        let request = RequestMeta {
            ip: "127.0.0.1".to_owned(),
            user_agent: "test".to_owned(),
            request_id: "audit-transaction-test".to_owned(),
        };
        let mut tx = db.begin().await?;
        audit_tx(
            &mut tx,
            &request,
            AuditEntry {
                action: "test.atomic",
                actor_id: None,
                target_type: Some("test"),
                target_id: None,
                meta: serde_json::json!({}),
            },
        )
        .await?;
        tx.rollback().await?;
        let rows: i64 = sqlx::query_scalar(
            "select count(*) from audit_log where request_id='audit-transaction-test'",
        )
        .fetch_one(&db)
        .await?;
        assert_eq!(rows, 0);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn exhausted_budget_returns_retry_after(db: PgPool) {
        let budget = Limit {
            limit: 1,
            window: Duration::from_secs(60),
        };
        assert!(
            enforce_rate_limit(&db, "test-key", budget)
                .await
                .unwrap()
                .allowed
        );
        let response = match enforce_rate_limit(&db, "test-key", budget).await {
            Err(error) => error.into_response(),
            Ok(_) => panic!("budget should be exhausted"),
        };
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
    }
}
