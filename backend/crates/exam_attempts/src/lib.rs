//! Candidate attempt lifecycle. Answer writers share the sequence-guarded [`store`] module.
mod api;
pub mod store;
pub use api::router;

use examcore::{AppError, AppResult, invalid};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use time::OffsetDateTime;
use uuid::Uuid;

pub const JOURNAL_GRACE_SECS: i64 = 120;

/// Shared online/journal validation. `item` contains `kind`, `options`, and `max_words` columns.
pub fn validate_response(item: &PgRow, response: &Value) -> AppResult<()> {
    validate_response_fields(&item.try_get::<String, _>("kind")?, &item.try_get("options")?,
        item.try_get("max_words")?, response)
}

fn validate_response_fields(kind: &str, options: &Value, max_words: Option<i32>, response: &Value) -> AppResult<()> {
    let object = response.as_object().ok_or_else(|| invalid("response", "An answer object is required."))?;
    let field = match kind {
        "written" => "text",
        "single" | "multi" => "selected",
        _ => return Err(AppError::internal("Invalid frozen item kind.")),
    };
    if object.len() != 1 || !object.contains_key(field) {
        return Err(invalid("response", "Only the answer field for this item is allowed."));
    }
    if kind == "written" {
        let text = response["text"].as_str().ok_or_else(|| invalid("response.text", "Text is required."))?;
        let chars = text.chars().count();
        if chars > 20_000 || max_words.is_some_and(|n| n <= 0 || chars > n as usize * 12)
            || serde_json::to_vec(response).map_err(AppError::internal)?.len() > 60_000 {
            return Err(invalid("response.text", "Written answer is too long."));
        }
        return Ok(());
    }
    let selected = response["selected"].as_array().ok_or_else(|| invalid("response.selected", "Selections are required."))?;
    let allowed: std::collections::HashSet<&str> = options.as_array().into_iter().flatten()
        .filter_map(|o| o.get("id").and_then(Value::as_str)).collect();
    if selected.len() > allowed.len() || (kind == "single" && selected.len() > 1) {
        return Err(invalid("response.selected", "Too many options selected."));
    }
    let mut unique = std::collections::HashSet::new();
    for selection in selected {
        let id = selection.as_str().ok_or_else(|| invalid("response.selected", "Option ids must be text."))?;
        if !allowed.contains(id) || !unique.insert(id) {
            return Err(invalid("response.selected", "Selections must be unique valid option ids."));
        }
    }
    Ok(())
}

/// Finalize and autograde once in the caller's transaction. The update holds the attempt lock
/// until commit. Request callers lock before checking time to serialize answer writes.
pub async fn finalize(conn: &mut PgConnection, attempt_id: Uuid, by: &str) -> AppResult<()> {
    if !matches!(by, "candidate" | "timer" | "examiner") {
        return Err(invalid("by", "Invalid finalizer."));
    }
    let target = if by == "timer" { "expired" } else { "submitted" };
    let changed: Option<Uuid> = sqlx::query_scalar(
        "update attempts set status=$2,submitted_at=clock_timestamp(),finalized_by=$3,
           updated_at=clock_timestamp() where id=$1 and status='in_progress' returning id",
    ).bind(attempt_id).bind(target).bind(by).fetch_optional(&mut *conn).await?;
    if changed.is_some() {
        sqlx::query("insert into attempt_events(attempt_id,kind) values($1,$2)")
            .bind(attempt_id).bind(if by == "timer" { "expired" } else { "submitted" })
            .execute(&mut *conn).await?;
        exam_grading::autograde_attempt(conn, attempt_id).await?;
    }
    Ok(())
}

/// Expire attempts after journal grace, claiming bounded batches without blocking other workers.
pub async fn sweep(db: &PgPool) -> AppResult<u64> {
    let mut total = 0_u64;
    loop {
        let mut tx = db.begin().await?;
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select id from attempts where status='in_progress'
             and deadline_at + ($1 * interval '1 second') < clock_timestamp()
             order by deadline_at limit 200 for update skip locked",
        ).bind(JOURNAL_GRACE_SECS as f64).fetch_all(&mut *tx).await?;
        for id in &ids { finalize(&mut tx, *id, "timer").await?; }
        total += ids.len() as u64;
        tx.commit().await?;
        if ids.len() < 200 { return Ok(total); }
    }
}

/// Start/resume in a caller-owned transaction (also used by the seed). Enrollment locking
/// serializes double starts and accommodation/revocation changes.
pub async fn start_attempt_tx(tx: &mut Transaction<'_, Postgres>, exam_id: Uuid, candidate_id: Uuid, device: Option<&str>) -> AppResult<Uuid> {
    if device.is_some_and(|d| !valid_device(d)) {
        return Err(invalid("X-Attempt-Device", "Invalid device token."));
    }
    let row = sqlx::query(
        "select en.extra_minutes,e.status,e.starts_at,e.ends_at,e.duration_minutes,e.settings
         from enrollments en join exams e on e.id=en.exam_id
         where en.exam_id=$1 and en.candidate_id=$2 and en.status='enrolled'
           and e.deleted_at is null and e.status in ('published','completed')
         for share of e for update of en",
    ).bind(exam_id).bind(candidate_id).fetch_optional(&mut **tx).await?.ok_or_else(AppError::not_found)?;
    // Resume BEFORE new-start window checks: reconnecting must work after late join closes.
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "select id from attempts where exam_id=$1 and candidate_id=$2 and not sandbox for update",
    ).bind(exam_id).bind(candidate_id).fetch_optional(&mut **tx).await? {
        sqlx::query("update attempts set active_device=coalesce(active_device,$2) where id=$1")
            .bind(id).bind(device).execute(&mut **tx).await?;
        sqlx::query("insert into attempt_events(attempt_id,kind) values($1,'resumed')")
            .bind(id).execute(&mut **tx).await?;
        return Ok(id);
    }
    let now = examcore::now(); // Wall time AFTER potentially waiting for locks.
    let starts: OffsetDateTime = row.try_get("starts_at")?;
    let ends: OffsetDateTime = row.try_get("ends_at")?;
    let settings: Value = row.try_get("settings")?;
    if row.try_get::<String, _>("status")? != "published" || now < starts || now >= ends
        || late_join_closed(&settings, starts, now) {
        return Err(examcore::conflict("closed", "This exam is not available to start."));
    }
    let seed = OsRng.next_u64() as i64;
    let mut genesis = vec![0_u8; 32];
    OsRng.fill_bytes(&mut genesis);
    let items = sqlx::query(
        "select id,position,kind,options from exam_items where exam_id=$1 and not sandbox order by position",
    ).bind(exam_id).fetch_all(&mut **tx).await?;
    let mut item_ids: Vec<Uuid> = items.iter().map(|i| i.try_get("id")).collect::<Result<_, _>>()?;
    if settings["shuffleQuestions"].as_bool().unwrap_or(false) { examcore::shuffle(&mut item_ids, seed as u64); }
    let mut orders = serde_json::Map::new();
    for item in items {
        if item.try_get::<String, _>("kind")? != "written" {
            let options: Value = item.try_get("options")?;
            let mut ids: Vec<String> = options.as_array().into_iter().flatten()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
            if settings["shuffleOptions"].as_bool().unwrap_or(false) {
                examcore::shuffle(&mut ids, seed as u64 ^ item.try_get::<i32, _>("position")? as u64);
            }
            orders.insert(item.try_get::<Uuid, _>("id")?.to_string(), json!(ids));
        }
    }
    let duration = i64::from(row.try_get::<i32, _>("duration_minutes")?) + i64::from(row.try_get::<i32, _>("extra_minutes")?);
    let deadline = (now + time::Duration::minutes(duration)).min(ends);
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "insert into attempts(exam_id,candidate_id,started_at,deadline_at,seed,item_order,option_order,journal_genesis,active_device)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict(exam_id,candidate_id) where not sandbox do nothing returning id",
    ).bind(exam_id).bind(candidate_id).bind(now).bind(deadline).bind(seed).bind(item_ids)
        .bind(Value::Object(orders)).bind(genesis).bind(device).fetch_optional(&mut **tx).await?;
    let id = if let Some(id) = inserted { id } else {
        sqlx::query_scalar("select id from attempts where exam_id=$1 and candidate_id=$2 and not sandbox")
            .bind(exam_id).bind(candidate_id).fetch_one(&mut **tx).await?
    };
    sqlx::query("insert into attempt_events(attempt_id,kind) values($1,$2)")
        .bind(id).bind(if inserted.is_some() { "started" } else { "resumed" }).execute(&mut **tx).await?;
    Ok(id)
}

/// Idempotent seed/request submit helper. Locks before checking the authoritative deadline.
pub async fn submit_tx(conn: &mut PgConnection, attempt_id: Uuid) -> AppResult<()> {
    let deadline: OffsetDateTime = sqlx::query_scalar("select deadline_at from attempts where id=$1 for update")
        .bind(attempt_id).fetch_optional(&mut *conn).await?.ok_or_else(AppError::not_found)?;
    finalize(conn, attempt_id, if examcore::now() > deadline { "timer" } else { "candidate" }).await
}

fn late_join_closed(settings: &Value, starts: OffsetDateTime, now: OffsetDateTime) -> bool {
    settings.get("lateJoinMinutes").and_then(Value::as_i64)
        .is_some_and(|m| now > starts + time::Duration::minutes(m))
}

fn valid_device(device: &str) -> bool {
    (8..=64).contains(&device.len()) && device.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Insert after the first space: U+2060, the UUID's first eight bytes in MSB-first bit order
/// as U+200B (0) / U+200C (1), then U+2060. Integrity tooling decodes these 64 invisible bits.
pub fn watermark(stem: &str, attempt_id: Uuid) -> String {
    let mut marker = String::new();
    marker.push('\u{2060}');
    for byte in &attempt_id.as_bytes()[..8] {
        for shift in (0..8).rev() { marker.push(if (byte >> shift) & 1 == 0 { '\u{200b}' } else { '\u{200c}' }); }
    }
    marker.push('\u{2060}');
    match stem.find(' ') {
        Some(pos) => format!("{}{}{}", &stem[..pos + 1], marker, &stem[pos + 1..]),
        None => format!("{stem}{marker}"),
    }
}

const CANARY_WORDS: [&str; 20] = [
    "apricity", "brontide", "cynosure", "defenestrate", "eluviate", "farrago", "gloaming",
    "halcyon", "imbricate", "jentacular", "kakistocracy", "luculent", "mellifluous", "noctilucent",
    "obfuscate", "petrichor", "quincunx", "rutilant", "susurrus", "ultracrepidarian",
];
/// Select a stable per-exam token from a fixed list, never candidate input.
pub fn canary_word(exam_id: Uuid) -> &'static str {
    let digest = kernel::crypto::sha256(exam_id.as_bytes());
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    CANARY_WORDS[(u64::from_be_bytes(bytes) % CANARY_WORDS.len() as u64) as usize]
}

#[cfg(test)]
mod tests;
