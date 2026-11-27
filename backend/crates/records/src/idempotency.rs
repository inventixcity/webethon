use kernel::{AppError, AppResult, ErrorCode, crypto};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn key(headers: &axum::http::HeaderMap) -> AppResult<Option<String>> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| AppError::bad_request("Invalid idempotency key."))?;
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(AppError::bad_request("Invalid idempotency key."));
    }
    Ok(Some(value.to_owned()))
}
/// Rebuilds a value with every object's keys sorted (arrays keep their order), so two bodies that
/// differ only in key order hash the same. Needed because serde_json preserves insertion order here.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

pub fn hash(entity: &str, body: &Value) -> AppResult<Vec<u8>> {
    let canonical = serde_json::to_vec(&canonical(body)).map_err(AppError::internal)?;
    let mut input = format!("POST:/api/v1/entities/{entity}:").into_bytes();
    input.extend(canonical);
    Ok(crypto::sha256(&input).to_vec())
}
type Stored = (Vec<u8>, Option<i32>, Option<Value>, bool);
pub async fn reserve(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    key: &str,
    hash: &[u8],
) -> AppResult<Option<Value>> {
    let lock: bool =
        sqlx::query_scalar("select pg_try_advisory_xact_lock(hashtextextended($1, 1))")
            .bind(format!("{owner}:{key}"))
            .fetch_one(&mut **tx)
            .await?;
    if !lock {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "A request with this key is in progress.",
        ));
    }
    sqlx::query("delete from idempotency_keys where owner_id=$1 and key=$2 and created_at < now() - interval '24 hours'").bind(owner).bind(key).execute(&mut **tx).await?;
    let row: Option<Stored> = sqlx::query_as("select request_hash,status,response,created_at > now() - interval '60 seconds' from idempotency_keys where owner_id=$1 and key=$2").bind(owner).bind(key).fetch_optional(&mut **tx).await?;
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
            return Err(AppError::new(
                ErrorCode::Conflict,
                "A request with this key is in progress.",
            ));
        }
        sqlx::query("delete from idempotency_keys where owner_id=$1 and key=$2")
            .bind(owner)
            .bind(key)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("insert into idempotency_keys(owner_id,key,request_hash) values($1,$2,$3)")
        .bind(owner)
        .bind(key)
        .bind(hash)
        .execute(&mut **tx)
        .await?;
    Ok(None)
}
