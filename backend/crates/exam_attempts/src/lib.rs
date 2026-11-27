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

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlueprintDrawRow {
    topic: String,
    min_difficulty: i16,
    max_difficulty: i16,
    count: i32,
    marks_each: f64,
}
#[derive(Clone)]
struct DrawItem {
    id: Uuid,
    topic: String,
    difficulty: i16,
    facility: f64,
}

/// Assign every blueprint slot to a distinct item. Candidate item orders vary by seed, while
/// augmenting paths guarantee that an earlier broad row can yield an item to a narrower row.
fn blueprint_assignment(
    rows: &[BlueprintDrawRow],
    items: &[DrawItem],
    seed: u64,
) -> Option<Vec<(usize, usize)>> {
    if rows.iter().any(|row| row.count < 1)
        || rows.iter().map(|row| row.count as usize).sum::<usize>() > items.len()
    {
        return None;
    }
    let mut row_pools = Vec::with_capacity(rows.len());
    let mut slots = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let mut eligible: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.topic == row.topic
                    && (row.min_difficulty..=row.max_difficulty).contains(&item.difficulty)
            })
            .map(|(index, _)| index)
            .collect();
        examcore::shuffle(
            &mut eligible,
            seed.wrapping_add((row_index as u64).wrapping_mul(0x9e3779b97f4a7c15)),
        );
        if eligible.len() < row.count as usize {
            return None;
        }
        row_pools.push(eligible);
        for _ in 0..row.count {
            slots.push((row_index, row_pools[row_index].clone()));
        }
    }
    if slots.len() > items.len() {
        return None;
    }
    let mut order: Vec<usize> = (0..slots.len()).collect();
    order.sort_by_key(|slot| (slots[*slot].1.len(), slots[*slot].0, *slot));
    let mut item_slots = vec![None; items.len()];
    let mut slot_items = vec![None; slots.len()];
    for slot in order {
        let mut seen = vec![false; items.len()];
        if !augment_blueprint_slot(slot, &slots, &mut item_slots, &mut slot_items, &mut seen) {
            return None;
        }
    }
    slot_items
        .into_iter()
        .enumerate()
        .map(|(slot, item)| item.map(|item| (slots[slot].0, item)))
        .collect()
}

fn augment_blueprint_slot(
    slot: usize,
    slots: &[(usize, Vec<usize>)],
    item_slots: &mut [Option<usize>],
    slot_items: &mut [Option<usize>],
    seen: &mut [bool],
) -> bool {
    for &item in &slots[slot].1 {
        if seen[item] {
            continue;
        }
        seen[item] = true;
        if item_slots[item].is_none_or(|previous| {
            augment_blueprint_slot(previous, slots, item_slots, slot_items, seen)
        }) {
            item_slots[item] = Some(slot);
            slot_items[slot] = Some(item);
            return true;
        }
    }
    false
}

/// Shared online/journal validation. `item` contains `kind`, `options`, and `max_words` columns.
pub fn validate_response(item: &PgRow, response: &Value) -> AppResult<()> {
    validate_response_fields(
        &item.try_get::<String, _>("kind")?,
        &item.try_get("options")?,
        item.try_get("max_words")?,
        response,
    )
}

fn validate_response_fields(
    kind: &str,
    options: &Value,
    max_words: Option<i32>,
    response: &Value,
) -> AppResult<()> {
    let object = response
        .as_object()
        .ok_or_else(|| invalid("response", "An answer object is required."))?;
    let field = match kind {
        "written" => "text",
        "single" | "multi" => "selected",
        _ => return Err(AppError::internal("Invalid frozen item kind.")),
    };
    if object.len() != 1 || !object.contains_key(field) {
        return Err(invalid(
            "response",
            "Only the answer field for this item is allowed.",
        ));
    }
    if kind == "written" {
        let text = response["text"]
            .as_str()
            .ok_or_else(|| invalid("response.text", "Text is required."))?;
        let chars = text.chars().count();
        if text.contains('\0') {
            return Err(invalid(
                "response.text",
                "Text cannot contain null characters.",
            ));
        }
        if chars > 20_000 {
            return Err(invalid("response.text", "Written answer is too long."));
        }
        if let Some(max_words) = max_words
            && (max_words <= 0
                || text.split_whitespace().count() > max_words as usize
                || chars > max_words as usize * 12)
        {
            return Err(invalid(
                "response.text",
                "Written answer exceeds the word limit.",
            ));
        }
        return Ok(());
    }
    let selected = response["selected"]
        .as_array()
        .ok_or_else(|| invalid("response.selected", "Selections are required."))?;
    let allowed: std::collections::HashSet<&str> = options
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o.get("id").and_then(Value::as_str))
        .collect();
    if selected.len() > allowed.len() || (kind == "single" && selected.len() > 1) {
        return Err(invalid("response.selected", "Too many options selected."));
    }
    let mut unique = std::collections::HashSet::new();
    for selection in selected {
        let id = selection
            .as_str()
            .ok_or_else(|| invalid("response.selected", "Option ids must be text."))?;
        if !allowed.contains(id) || !unique.insert(id) {
            return Err(invalid(
                "response.selected",
                "Selections must be unique valid option ids.",
            ));
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
    let target = if by == "timer" {
        "expired"
    } else {
        "submitted"
    };
    let changed: Option<Uuid> = sqlx::query_scalar(
        "update attempts set status=$2,submitted_at=clock_timestamp(),finalized_by=$3,
           updated_at=clock_timestamp() where id=$1 and status='in_progress' returning id",
    )
    .bind(attempt_id)
    .bind(target)
    .bind(by)
    .fetch_optional(&mut *conn)
    .await?;
    if changed.is_some() {
        sqlx::query("insert into attempt_events(attempt_id,kind) values($1,$2)")
            .bind(attempt_id)
            .bind(if by == "timer" {
                "expired"
            } else {
                "submitted"
            })
            .execute(&mut *conn)
            .await?;
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
        )
        .bind(JOURNAL_GRACE_SECS as f64)
        .fetch_all(&mut *tx)
        .await?;
        for id in &ids {
            finalize(&mut tx, *id, "timer").await?;
        }
        total += ids.len() as u64;
        tx.commit().await?;
        if ids.len() < 200 {
            return Ok(total);
        }
    }
}

/// Start/resume in a caller-owned transaction (also used by the seed). Enrollment locking
/// serializes double starts and accommodation/revocation changes.
pub async fn start_attempt_tx(
    tx: &mut Transaction<'_, Postgres>,
    exam_id: Uuid,
    candidate_id: Uuid,
    device: Option<&str>,
) -> AppResult<Uuid> {
    if device.is_some_and(|d| !valid_device(d)) {
        return Err(invalid("X-Attempt-Device", "Invalid device token."));
    }
    let row = sqlx::query(
        "select en.extra_minutes,e.status,e.starts_at,e.ends_at,e.duration_minutes,e.settings
         from enrollments en join exams e on e.id=en.exam_id
         where en.exam_id=$1 and en.candidate_id=$2 and en.status='enrolled'
           and e.deleted_at is null and e.status in ('published','completed')
         for share of e for update of en",
    )
    .bind(exam_id)
    .bind(candidate_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    // Resume BEFORE new-start window checks: reconnecting must work after late join closes.
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "select id from attempts where exam_id=$1 and candidate_id=$2 and not sandbox for update",
    )
    .bind(exam_id)
    .bind(candidate_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        sqlx::query("update attempts set active_device=coalesce(active_device,$2) where id=$1")
            .bind(id)
            .bind(device)
            .execute(&mut **tx)
            .await?;
        sqlx::query("insert into attempt_events(attempt_id,kind) values($1,'resumed')")
            .bind(id)
            .execute(&mut **tx)
            .await?;
        return Ok(id);
    }
    let now = examcore::now(); // Wall time AFTER potentially waiting for locks.
    let starts: OffsetDateTime = row.try_get("starts_at")?;
    let ends: OffsetDateTime = row.try_get("ends_at")?;
    let settings: Value = row.try_get("settings")?;
    if row.try_get::<String, _>("status")? != "published"
        || now < starts
        || now >= ends
        || late_join_closed(&settings, starts, now)
    {
        return Err(examcore::conflict(
            "closed",
            "This exam is not available to start.",
        ));
    }
    let seed = OsRng.next_u64() as i64;
    let mut genesis = vec![0_u8; 32];
    OsRng.fill_bytes(&mut genesis);
    let items = sqlx::query(
        "select id,position,kind,options,topic,difficulty,predicted_facility::float8 predicted_facility from exam_items where exam_id=$1 and not sandbox order by position",
    ).bind(exam_id).fetch_all(&mut **tx).await?;
    let blueprint = sqlx::query(
        "select rows,tolerance::float8 tolerance from exam_blueprints where exam_id=$1 and enabled",
    )
    .bind(exam_id)
    .fetch_optional(&mut **tx)
    .await?;
    let mut predicted_facility: Option<f64> = None;
    let mut item_marks = serde_json::Map::new();
    let mut item_ids: Vec<Uuid> = items
        .iter()
        .map(|i| i.try_get("id"))
        .collect::<Result<_, _>>()?;
    if let Some(blueprint) = blueprint {
        let rows: Vec<BlueprintDrawRow> =
            serde_json::from_value(blueprint.try_get("rows")?).map_err(AppError::internal)?;
        let tolerance: f64 = blueprint.try_get("tolerance")?;
        let mut choices = Vec::new();
        for item in &items {
            choices.push(DrawItem {
                id: item.try_get("id")?,
                topic: item.try_get("topic")?,
                difficulty: item.try_get("difficulty")?,
                facility: item
                    .try_get::<Option<f64>, _>("predicted_facility")?
                    .unwrap_or(0.55),
            });
        }
        let total: usize = rows.iter().map(|row| row.count.max(0) as usize).sum();
        let mut target = 0.0;
        for row in &rows {
            let pool: Vec<f64> = choices
                .iter()
                .filter(|item| {
                    item.topic == row.topic
                        && (row.min_difficulty..=row.max_difficulty).contains(&item.difficulty)
                })
                .map(|item| item.facility)
                .collect();
            if pool.is_empty() {
                return Err(examcore::conflict(
                    "blueprint_pool",
                    "The published blueprint has no eligible items.",
                ));
            }
            target += pool.iter().sum::<f64>() / pool.len() as f64 * row.count as f64;
        }
        target /= total.max(1) as f64;
        let mut best_selected: Option<Vec<(Uuid, f64, f64)>> = None;
        let mut best_distance = f64::INFINITY;
        for variant in 0..200u64 {
            let Some(assignment) =
                blueprint_assignment(&rows, &choices, (seed as u64).wrapping_add(variant))
            else {
                continue;
            };
            let selected: Vec<(Uuid, f64, f64)> = assignment
                .iter()
                .map(|(row_index, item_index)| {
                    (
                        choices[*item_index].id,
                        choices[*item_index].facility,
                        rows[*row_index].marks_each,
                    )
                })
                .collect();
            let mean = selected
                .iter()
                .map(|(_, facility, _)| *facility)
                .sum::<f64>()
                / selected.len().max(1) as f64;
            let distance = (mean - target).abs();
            if distance < best_distance {
                best_distance = distance;
                best_selected = Some(selected.clone());
            }
            if distance <= tolerance {
                best_selected = Some(selected);
                break;
            }
        }
        let selected = best_selected.ok_or_else(|| {
            examcore::conflict(
                "blueprint_pool",
                "Blueprint rows cannot be filled with distinct questions.",
            )
        })?;
        if best_distance > tolerance {
            return Err(examcore::conflict(
                "fairness_unavailable",
                "No paper meets the configured fairness tolerance.",
            ));
        }
        predicted_facility =
            Some(selected.iter().map(|(_, f, _)| *f).sum::<f64>() / selected.len().max(1) as f64);
        item_ids = selected.iter().map(|(id, _, _)| *id).collect();
        for (id, _, marks) in selected {
            item_marks.insert(id.to_string(), json!(marks));
        }
    } else if settings["shuffleQuestions"].as_bool().unwrap_or(false) {
        examcore::shuffle(&mut item_ids, seed as u64);
    }
    let mut orders = serde_json::Map::new();
    for item in items {
        if item.try_get::<String, _>("kind")? != "written" {
            let options: Value = item.try_get("options")?;
            let mut ids: Vec<String> = options
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect();
            if settings["shuffleOptions"].as_bool().unwrap_or(false) {
                examcore::shuffle(
                    &mut ids,
                    seed as u64 ^ item.try_get::<i32, _>("position")? as u64,
                );
            }
            orders.insert(item.try_get::<Uuid, _>("id")?.to_string(), json!(ids));
        }
    }
    let duration = i64::from(row.try_get::<i32, _>("duration_minutes")?)
        + i64::from(row.try_get::<i32, _>("extra_minutes")?);
    let deadline = (now + time::Duration::minutes(duration)).min(ends);
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "insert into attempts(exam_id,candidate_id,started_at,deadline_at,seed,item_order,option_order,journal_genesis,active_device,predicted_facility,item_marks)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict(exam_id,candidate_id) where not sandbox do nothing returning id",
    ).bind(exam_id).bind(candidate_id).bind(now).bind(deadline).bind(seed).bind(item_ids)
        .bind(Value::Object(orders)).bind(genesis).bind(device).bind(predicted_facility).bind(Value::Object(item_marks)).fetch_optional(&mut **tx).await?;
    let id = if let Some(id) = inserted {
        id
    } else {
        sqlx::query_scalar(
            "select id from attempts where exam_id=$1 and candidate_id=$2 and not sandbox",
        )
        .bind(exam_id)
        .bind(candidate_id)
        .fetch_one(&mut **tx)
        .await?
    };
    sqlx::query("insert into attempt_events(attempt_id,kind) values($1,$2)")
        .bind(id)
        .bind(if inserted.is_some() {
            "started"
        } else {
            "resumed"
        })
        .execute(&mut **tx)
        .await?;
    Ok(id)
}

/// Idempotent seed/request submit helper. Locks before checking the authoritative deadline.
pub async fn submit_tx(conn: &mut PgConnection, attempt_id: Uuid) -> AppResult<()> {
    let deadline: OffsetDateTime =
        sqlx::query_scalar("select deadline_at from attempts where id=$1 for update")
            .bind(attempt_id)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(AppError::not_found)?;
    finalize(
        conn,
        attempt_id,
        if examcore::now() > deadline {
            "timer"
        } else {
            "candidate"
        },
    )
    .await
}

fn late_join_closed(settings: &Value, starts: OffsetDateTime, now: OffsetDateTime) -> bool {
    settings
        .get("lateJoinMinutes")
        .and_then(Value::as_i64)
        .is_some_and(|m| now > starts + time::Duration::minutes(m))
}

fn valid_device(device: &str) -> bool {
    (8..=64).contains(&device.len())
        && device
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Insert after the first space: U+2060, the UUID's first eight bytes in MSB-first bit order
/// as U+200B (0) / U+200C (1), then U+2060. Integrity tooling decodes these 64 invisible bits.
pub fn watermark(stem: &str, attempt_id: Uuid) -> String {
    let mut marker = String::new();
    marker.push('\u{2060}');
    for byte in &attempt_id.as_bytes()[..8] {
        for shift in (0..8).rev() {
            marker.push(if (byte >> shift) & 1 == 0 {
                '\u{200b}'
            } else {
                '\u{200c}'
            });
        }
    }
    marker.push('\u{2060}');
    match stem.find(' ') {
        Some(pos) => format!("{}{}{}", &stem[..pos + 1], marker, &stem[pos + 1..]),
        None => format!("{stem}{marker}"),
    }
}

const CANARY_WORDS: [&str; 20] = [
    "apricity",
    "brontide",
    "cynosure",
    "defenestrate",
    "eluviate",
    "farrago",
    "gloaming",
    "halcyon",
    "imbricate",
    "jentacular",
    "kakistocracy",
    "luculent",
    "mellifluous",
    "noctilucent",
    "obfuscate",
    "petrichor",
    "quincunx",
    "rutilant",
    "susurrus",
    "ultracrepidarian",
];
/// Select a stable per-exam token from a fixed list, never candidate input.
pub fn canary_word(exam_id: Uuid) -> &'static str {
    let digest = kernel::crypto::sha256(exam_id.as_bytes());
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    CANARY_WORDS[(u64::from_be_bytes(bytes) % CANARY_WORDS.len() as u64) as usize]
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
