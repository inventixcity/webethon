use examcore::AppResult;
use serde_json::Value;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

/// The sole answer writer. Callers validate responses and hold the attempt row lock.
/// Equal or older sequences are ignored, including retries of the same request.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_answer(
    conn: &mut PgConnection,
    attempt_id: Uuid,
    item_id: Uuid,
    response: &Value,
    flagged: bool,
    seq: i64,
    source: &str,
    written_at: OffsetDateTime,
    typing: &Value,
) -> AppResult<bool> {
    let row: Option<Uuid> = sqlx::query_scalar(
        "insert into answers(attempt_id,item_id,response,flagged,client_seq,source,written_at,typing)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict(attempt_id,item_id) do update set
           response=excluded.response,flagged=excluded.flagged,client_seq=excluded.client_seq,
           source=excluded.source,written_at=excluded.written_at,
           typing=jsonb_build_object(
             'keystrokes', least(10000000::bigint, coalesce((answers.typing->>'keystrokes')::bigint, 0) + coalesce((excluded.typing->>'keystrokes')::bigint, 0)),
             'pastes', least(10000000::bigint, coalesce((answers.typing->>'pastes')::bigint, 0) + coalesce((excluded.typing->>'pastes')::bigint, 0)),
             'pastedChars', least(10000000::bigint, coalesce((answers.typing->>'pastedChars')::bigint, 0) + coalesce((excluded.typing->>'pastedChars')::bigint, 0)),
             'activeMs', least(10000000::bigint, coalesce((answers.typing->>'activeMs')::bigint, 0) + coalesce((excluded.typing->>'activeMs')::bigint, 0))
           ),
           saved_at=clock_timestamp()
         where answers.client_seq < excluded.client_seq returning item_id",
    ).bind(attempt_id).bind(item_id).bind(response).bind(flagged).bind(seq)
        .bind(source).bind(written_at).bind(typing).fetch_optional(conn).await?;
    Ok(row.is_some())
}
