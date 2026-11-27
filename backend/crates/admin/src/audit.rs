use kernel::{AppResult, Viewer, request::RequestMeta};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// The detail views show the newest audit rows only, so one busy target can't bloat a response.
pub(crate) const HISTORY_LIMIT: i64 = 50;
// The target type is bound as a value. Only fixed strings from the admin code reach this query.
const HISTORY_SQL: &str = "select id,at,actor_id,action,meta from audit_log \
    where target_type=$1 and target_id=$2 order by at desc,id desc limit $3";

#[derive(FromRow)]
struct HistoryRow {
    id: i64,
    at: OffsetDateTime,
    actor_id: Option<Uuid>,
    action: String,
    meta: Value,
}

/// The newest audit rows for one target, as the detail views show them. Meta is sanitized again on
/// read, so rows written before the redaction rule existed are covered too.
pub(crate) async fn history(db: &PgPool, target_type: &str, id: Uuid) -> AppResult<Vec<Value>> {
    let rows: Vec<HistoryRow> = sqlx::query_as(HISTORY_SQL)
        .bind(target_type)
        .bind(id.to_string())
        .bind(HISTORY_LIMIT)
        .fetch_all(db)
        .await?;
    rows.into_iter()
        .map(|row| -> AppResult<Value> {
            Ok(json!({
                "id": row.id,
                "at": crate::shared::rfc3339(row.at)?,
                "actorId": row.actor_id,
                "action": row.action,
                "meta": sanitize(row.meta),
            }))
        })
        .collect()
}

/// Drops fields whose names suggest a secret. Used on writes and again on reads, so rows written
/// by other crates (or before this rule existed) are redacted too.
pub(crate) fn sanitize(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter_map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if [
                        "password",
                        "secret",
                        "token",
                        "hash",
                        "code",
                        "cookie",
                        "credential",
                        "authorization",
                        "nonce",
                    ]
                    .iter()
                    .any(|part| lower.contains(part))
                    {
                        None
                    } else {
                        Some((key, sanitize(value)))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize).collect()),
        other => other,
    }
}
#[allow(dead_code)]
pub(crate) async fn audit_before_after(
    tx: &mut Transaction<'_, Postgres>,
    meta: &RequestMeta,
    viewer: &Viewer,
    action: &str,
    target: (&str, &str),
    before: Value,
    after: Value,
) -> AppResult<()> {
    sqlx::query("insert into audit_log(actor_id,action,target_type,target_id,ip,user_agent,request_id,meta) values($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(viewer.id).bind(action).bind(target.0).bind(target.1).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({"before":sanitize(before),"after":sanitize(after)})).execute(&mut **tx).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_nested_sensitive_fields() {
        assert_eq!(
            sanitize(json!({"passwordHash":"x","child":[{"token":"x","role":"user"}]})),
            json!({"child":[{"role":"user"}]})
        );
    }
}
