//! `Idempotency-Key` handling for booking creation, following the records crate's rules:
//! the same key and the same request replay the first response; the same key with a different
//! request is refused; a request still in flight gets 409.

use axum::http::HeaderMap;
use kernel::{AppError, AppResult, ErrorCode, crypto};
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

pub fn key(headers: &HeaderMap) -> AppResult<Option<String>> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| AppError::bad_request("Invalid idempotency key."))?;
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AppError::bad_request("Invalid idempotency key."));
    }
    Ok(Some(value.to_owned()))
}

/// Hashes the operation name and the canonical request. Object keys are sorted first, so
/// field order in the JSON doesn't matter.
pub fn hash(operation: &str, body: &Value) -> AppResult<Vec<u8>> {
    let canonical = serde_json::to_vec(&sort_keys(body)).map_err(AppError::internal)?;
    let mut input = format!("{operation}:").into_bytes();
    input.extend(canonical);
    Ok(crypto::sha256(&input).to_vec())
}

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sort_keys(&map[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

type Stored = (Vec<u8>, Option<i32>, Option<Value>, bool);

/// Reserves the key inside the caller's transaction. Returns the stored response on a replay.
/// A reservation is rolled back with the transaction, so a failed request leaves no key behind.
pub async fn reserve(
    db: &mut PgConnection,
    owner: Uuid,
    key: &str,
    hash: &[u8],
) -> AppResult<Option<Value>> {
    let locked: bool =
        sqlx::query_scalar("select pg_try_advisory_xact_lock(hashtextextended($1, 1))")
            .bind(format!("booking:{owner}:{key}"))
            .fetch_one(&mut *db)
            .await?;
    if !locked {
        return Err(in_progress());
    }
    sqlx::query(
        "delete from idempotency_keys where owner_id = $1 and key = $2 and created_at < now() - interval '24 hours'",
    )
    .bind(owner)
    .bind(key)
    .execute(&mut *db)
    .await?;
    let row: Option<Stored> = sqlx::query_as(
        "select request_hash, status, response, created_at > now() - interval '60 seconds'
         from idempotency_keys where owner_id = $1 and key = $2",
    )
    .bind(owner)
    .bind(key)
    .fetch_optional(&mut *db)
    .await?;
    if let Some((old, status, response, recent)) = row {
        if !crypto::constant_time_eq(&old, hash) {
            return Err(AppError::new(
                ErrorCode::IdempotencyMismatch,
                "This key was used for a different request.",
            ));
        }
        if status.is_some() {
            return response
                .map(Some)
                .ok_or_else(|| AppError::internal("missing idempotency response"));
        }
        if recent {
            return Err(in_progress());
        }
        sqlx::query("delete from idempotency_keys where owner_id = $1 and key = $2")
            .bind(owner)
            .bind(key)
            .execute(&mut *db)
            .await?;
    }
    sqlx::query("insert into idempotency_keys (owner_id, key, request_hash) values ($1, $2, $3)")
        .bind(owner)
        .bind(key)
        .bind(hash)
        .execute(&mut *db)
        .await?;
    Ok(None)
}

/// Saves the response of a finished request so a retry can replay it.
pub async fn store(
    db: &mut PgConnection,
    owner: Uuid,
    key: &str,
    response: &Value,
) -> AppResult<()> {
    sqlx::query(
        "update idempotency_keys set status = 201, response = $3 where owner_id = $1 and key = $2",
    )
    .bind(owner)
    .bind(key)
    .bind(response)
    .execute(db)
    .await?;
    Ok(())
}

fn in_progress() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "A request with this key is in progress.",
    )
}
