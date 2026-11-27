//! Failure resilient attempts: signed time leases, an ordered offline journal and audited recovery.
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
};
use examcore::{
    ExaminerViewer, Lease, invalid,
    kernel::{
        AppError, AppResult, AppState, Viewer,
        request::RequestMeta,
        security::{self, AuditEntry, Limit},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use exam_attempts::JOURNAL_GRACE_SECS;

// The journal's receipt grace is deliberately shorter than the attempt finalizer grace.
const JOURNAL_RECEIPT_GRACE_SECS: i64 = 90;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/attempts/{id}/heartbeat", post(heartbeat))
        .route("/attempts/{id}/journal", post(journal))
        .route("/attempts/{id}/takeover", post(takeover))
        .route("/attempts/{id}/outages", get(outages))
        .route("/attempts/{id}/time-credit", post(time_credit))
        .route("/exams/{id}/outage-credit", post(bulk_credit))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeartbeatInput {
    online: bool,
    pending: i32,
    last_announcement_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalInput {
    entries: Vec<JournalEntry>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalEntry {
    seq: i64,
    item_id: Uuid,
    response: Value,
    flagged: bool,
    #[serde(deserialize_with = "strict_lease")]
    lease: Lease,
    elapsed_ms: i64,
    written_at: i64,
    hash: String,
}

fn strict_lease<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Lease, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        attempt_id: Uuid,
        issued_at: i64,
        deadline_at: i64,
        mac: String,
    }
    let input = Input::deserialize(deserializer)?;
    Ok(Lease {
        attempt_id: input.attempt_id,
        issued_at: input.issued_at,
        deadline_at: input.deadline_at,
        mac: input.mac,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreditInput {
    seconds: i32,
    reason: String,
    outage_from: Option<String>,
    outage_to: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BulkCreditInput {
    from: String,
    to: String,
    reason: String,
}

async fn owner_attempt(db: &sqlx::PgPool, viewer: &Viewer, id: Uuid) -> AppResult<(Uuid, Uuid)> {
    let row = sqlx::query("select a.candidate_id,a.exam_id,a.sandbox,e.owner_id from attempts a join exams e on e.id=a.exam_id where a.id=$1")
        .bind(id).fetch_optional(db).await?.ok_or_else(AppError::not_found)?;
    let candidate: Uuid = row.try_get("candidate_id")?;
    let exam: Uuid = row.try_get("exam_id")?;
    let sandbox: bool = row.try_get("sandbox")?;
    let owner: Uuid = row.try_get("owner_id")?;
    if (!sandbox && viewer.is_candidate() && viewer.id == candidate)
        || (sandbox
            && viewer.can_examine()
            && viewer.id == candidate
            && (viewer.id == owner || viewer.is_admin()))
    {
        Ok((exam, candidate))
    } else {
        Err(AppError::not_found())
    }
}

fn device(headers: &HeaderMap) -> AppResult<String> {
    let value = headers
        .get("x-attempt-device")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(8..=64).contains(&value.len())
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(invalid("X-Attempt-Device", "Invalid device token."));
    }
    Ok(value.to_owned())
}
fn stamp(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}
async fn rate(state: &AppState, id: Uuid, action: &str, max: i32, secs: u64) -> AppResult<()> {
    security::enforce_rate_limit(
        &state.db,
        &format!("exam-resilience:{action}:{id}"),
        Limit {
            limit: max,
            window: Duration::from_secs(secs),
        },
    )
    .await?;
    Ok(())
}

async fn heartbeat(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    v: Viewer,
    headers: HeaderMap,
    meta: RequestMeta,
    Json(input): Json<HeartbeatInput>,
) -> AppResult<Json<Value>> {
    owner_attempt(&s.db, &v, id).await?;
    let device = device(&headers)?;
    if input.pending < 0 || input.pending > 100_000 {
        return Err(invalid(
            "pending",
            "Pending count is outside the allowed range.",
        ));
    }
    let after = input
        .last_announcement_at
        .as_deref()
        .map(|x| {
            OffsetDateTime::parse(x, &Rfc3339)
                .map_err(|_| invalid("lastAnnouncementAt", "Invalid timestamp."))
        })
        .transpose()?;
    rate(&s, id, "heartbeat", 20, 60).await?;
    let mut tx = s.db.begin().await?;
    let row = sqlx::query("select status,deadline_at,active_device,last_heartbeat_at from attempts where id=$1 for update").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let status: String = row.try_get("status")?;
    let deadline: OffsetDateTime = row.try_get("deadline_at")?;
    let active: Option<String> = row.try_get("active_device")?;
    let previous: Option<OffsetDateTime> = row.try_get("last_heartbeat_at")?;
    let now: OffsetDateTime = sqlx::query_scalar("select clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if status == "in_progress" && now > deadline + time::Duration::seconds(JOURNAL_GRACE_SECS) {
        exam_attempts::finalize(&mut tx, id, "timer").await?;
    }
    let device_active = active.as_deref().is_none_or(|d| d == device);
    if device_active {
        sqlx::query(
            "insert into attempt_heartbeats(attempt_id,at,online,pending) values($1,$2,$3,$4)",
        )
        .bind(id)
        .bind(now)
        .bind(input.online)
        .bind(input.pending)
        .execute(&mut *tx)
        .await?;
        sqlx::query("update attempts set last_heartbeat_at=$2,active_device=coalesce(active_device,$3),updated_at=now() where id=$1").bind(id).bind(now).bind(&device).execute(&mut *tx).await?;
        if let Some(prev) = previous.filter(|p| now - *p >= time::Duration::seconds(45)) {
            let gap = (now - prev).whole_milliseconds().clamp(0, 86_400_000) as i32;
            sqlx::query("insert into attempt_events(attempt_id,kind,detail,duration_ms) values($1,'offline',$2,$3),($1,'online',$2,$3)").bind(id).bind(json!({"verified":true})).bind(gap).execute(&mut *tx).await?;
        }
    }
    let announcements: Vec<Value> = sqlx::query("select id,body,created_at from announcements where exam_id=(select exam_id from attempts where id=$1) and ($2::timestamptz is null or created_at>$2) order by created_at limit 100")
        .bind(id).bind(after).fetch_all(&mut *tx).await?.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"body":r.get::<String,_>("body"),"createdAt":stamp(r.get("created_at"))})).collect();
    let status: String = sqlx::query_scalar("select status from attempts where id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    if v.can_examine() && device_active {
        security::audit(
            &s.db,
            &meta,
            AuditEntry {
                action: "attempt.heartbeat",
                actor_id: Some(v.id),
                target_type: Some("attempt"),
                target_id: Some(id.to_string()),
                meta: json!({}),
            },
        )
        .await;
    }
    Ok(examcore::ok(
        json!({"serverNow":stamp(examcore::now()),"deadlineAt":stamp(deadline),"status":status,"lease":examcore::issue_lease(id,deadline),"deviceActive":device_active,"announcements":announcements}),
    ))
}

/// The journal lets a candidate continue through a network outage. Residual risk: while offline and
/// within the signed lease window, a candidate could consult resources; that is the same risk as an
/// online candidate. They cannot extend time because claimed times are bound to a server lease, real
/// elapsed time and the attempt deadline. The hash chain detects corruption and reordering, not
/// malicious client execution: it is unkeyed. A modified client can backdate within a valid lease;
/// neither the monotonic timer nor a hash proves when a human typed. Receipt is independently
/// bounded by a 90-second receipt grace and accepted after the deadline only when no heartbeat
/// was recorded during the final 30 seconds before it. Therefore the maximum fabricated gain is
/// 90 seconds, and only for a device verifiably offline at the deadline; a lease/hash cannot prove
/// when a human typed.
async fn journal(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    v: Viewer,
    headers: HeaderMap,
    meta: RequestMeta,
    Json(input): Json<JournalInput>,
) -> AppResult<Json<Value>> {
    owner_attempt(&s.db, &v, id).await?;
    let requesting_device = device(&headers)?;
    rate(&s, id, "journal", 30, 60).await?;
    if input.entries.is_empty() || input.entries.len() > 200 {
        return Err(invalid("entries", "Submit between 1 and 200 entries."));
    }
    let mut tx = s.db.begin().await?;
    let row=sqlx::query("select a.status,a.deadline_at,a.active_device,a.device_changed_at,a.item_order,a.journal_genesis,a.journal_head,a.journal_seq,e.settings from attempts a join exams e on e.id=a.exam_id where a.id=$1 for update of a").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let now: OffsetDateTime = sqlx::query_scalar("select clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let mut status: String = row.try_get("status")?;
    let deadline: OffsetDateTime = row.try_get("deadline_at")?;
    let offline_at_deadline: bool = sqlx::query_scalar(
        "select not exists(select 1 from attempt_heartbeats where attempt_id=$1 and at >= $2 - interval '30 seconds' and at <= $2)",
    )
    .bind(id)
    .bind(deadline)
    .fetch_one(&mut *tx)
    .await?;
    if !row
        .try_get::<Value, _>("settings")?
        .get("allowOfflineJournal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(examcore::conflict(
            "disabled",
            "Offline journal is disabled for this exam.",
        ));
    }
    let active_device: Option<String> = row.try_get("active_device")?;
    if active_device.as_deref() != Some(requesting_device.as_str()) {
        return Err(examcore::conflict(
            "device",
            "This device no longer controls the attempt.",
        ));
    }
    let order: Vec<Uuid> = row.try_get("item_order")?;
    let changed: Option<OffsetDateTime> = row.try_get("device_changed_at")?;
    let mut head: Vec<u8> = row
        .try_get::<Option<Vec<u8>>, _>("journal_head")?
        .unwrap_or(row.try_get("journal_genesis")?);
    let mut seq: i64 = row.try_get("journal_seq")?;
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut late_synced = 0_usize;
    let mut chain_broken = false;
    for entry in input.entries {
        let mut reason: Option<&str> = None;
        let lease_ok = examcore::verify_lease(&entry.lease, id)
            && entry.elapsed_ms >= 0
            && Some(entry.written_at) == entry.lease.issued_at.checked_add(entry.elapsed_ms)
            && changed.is_none_or(|at| entry.lease.issued_at >= examcore::unix_ms(at));
        if now > deadline + time::Duration::seconds(JOURNAL_RECEIPT_GRACE_SECS)
            // A candidate's own submit is final (the client syncs its journal before submitting).
            // Only a timer expiry keeps the grace window open for entries written before the deadline.
            || !matches!(status.as_str(), "in_progress" | "expired")
        {
            reason = Some("closed");
        } else if chain_broken {
            reason = Some("chain");
        } else if !lease_ok {
            reason = Some("lease");
        } else if entry.written_at > examcore::unix_ms(now) {
            reason = Some("future");
        } else if entry.written_at > examcore::unix_ms(deadline)
            || entry.written_at > entry.lease.deadline_at
            // Received after the deadline from a device that was online at the deadline: not a verified outage.
            || (now > deadline && !offline_at_deadline)
        {
            reason = Some("late");
        } else if entry.seq <= seq {
            reason = Some("stale");
        } else if entry.seq != seq + 1
            || entry.seq > 9_007_198_254_740_991
            || examcore::unb64(&entry.hash).is_none_or(|got| {
                got != examcore::chain_next(
                    &head,
                    entry.seq,
                    entry.item_id,
                    &entry.response,
                    entry.written_at,
                )
            })
        {
            reason = Some("chain");
        } else {
            let item=sqlx::query("select kind,options,max_words from exam_items where id=$1 and exam_id=(select exam_id from attempts where id=$2)").bind(entry.item_id).bind(id).fetch_optional(&mut *tx).await?;
            if let Some(item) = item.filter(|_| order.contains(&entry.item_id)) {
                if exam_attempts::validate_response(&item, &entry.response).is_err() {
                    reason = Some("stale");
                }
            } else {
                reason = Some("stale");
            }
        }
        if let Some(reason) = reason {
            // Committed prefixes are idempotent retries; any rejected NEW entry breaks its suffix.
            if entry.seq > seq {
                chain_broken = true;
            }
            rejected.push(json!({"seq":entry.seq,"reason":reason}));
            continue;
        }
        let written = examcore::from_unix_ms(entry.written_at)
            .ok_or_else(|| invalid("entries.writtenAt", "Invalid timestamp."))?;
        // Every browser edit is journaled, including online edits. Its PUT uses this same high
        // sequence, so replay cannot overwrite a newer edit and future online edits still win.
        let save_seq = entry
            .seq
            .checked_add(1_000_000_000)
            .ok_or_else(|| invalid("entries.seq", "Sequence is too large."))?;
        exam_attempts::store::upsert_answer(
            &mut tx,
            id,
            entry.item_id,
            &entry.response,
            entry.flagged,
            save_seq,
            "journal",
            written,
            &json!({}),
        )
        .await?;
        head = examcore::chain_next(
            &head,
            entry.seq,
            entry.item_id,
            &entry.response,
            entry.written_at,
        )
        .to_vec();
        seq = entry.seq;
        accepted.push(entry.seq);
        if now > deadline {
            late_synced += 1;
        }
    }
    if status == "in_progress" && now > deadline {
        exam_attempts::finalize(&mut tx, id, "timer").await?;
        status = "expired".into();
    }
    let head_text = if seq > 0 {
        Some(examcore::b64(&head))
    } else {
        None
    };
    if !accepted.is_empty() {
        sqlx::query("update attempts set journal_head=$2,journal_seq=$3 where id=$1")
            .bind(id)
            .bind(&head)
            .bind(seq)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'journal_synced',$2,$3)").bind(id).bind(if rejected.is_empty() && late_synced == 0 {"info"} else {"notice"}).bind(json!({"accepted":accepted.len(),"rejected":rejected.len(),"lateSynced":late_synced})).execute(&mut *tx).await?;
    if status != "in_progress" && !accepted.is_empty() {
        exam_grading::autograde_attempt(&mut tx, id).await?;
    }
    tx.commit().await?;
    if v.can_examine() {
        security::audit(
            &s.db,
            &meta,
            AuditEntry {
                action: "attempt.journal_synced",
                actor_id: Some(v.id),
                target_type: Some("attempt"),
                target_id: Some(id.to_string()),
                meta: json!({"accepted":accepted.len(),"rejected":rejected.len()}),
            },
        )
        .await;
    }
    Ok(examcore::ok(
        json!({"accepted":accepted,"rejected":rejected,"head":head_text,"seq":seq}),
    ))
}

async fn takeover(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    v: Viewer,
    headers: HeaderMap,
    meta: RequestMeta,
) -> AppResult<Json<Value>> {
    owner_attempt(&s.db, &v, id).await?;
    let new = device(&headers)?;
    rate(&s, id, "takeover", 5, 3600).await?;
    let mut tx = s.db.begin().await?;
    let row = sqlx::query("select active_device,status from attempts where id=$1 for update")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    if row.try_get::<String, _>("status")? != "in_progress" {
        return Err(examcore::conflict("closed", "Attempt is closed."));
    }
    let old: Option<String> = row.try_get("active_device")?;
    sqlx::query(
        "update attempts set active_device=$2,device_changed_at=clock_timestamp() where id=$1",
    )
    .bind(id)
    .bind(&new)
    .execute(&mut *tx)
    .await?;
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'device_takeover','warning',$2)").bind(id).bind(json!({"old":old.as_deref().map(short_hash),"new":short_hash(&new)})).execute(&mut *tx).await?;
    tx.commit().await?;
    security::audit(
        &s.db,
        &meta,
        AuditEntry {
            action: "attempt.device_takeover",
            actor_id: Some(v.id),
            target_type: Some("attempt"),
            target_id: Some(id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    Ok(examcore::ok(json!({"deviceActive":true})))
}
fn short_hash(value: &str) -> String {
    examcore::b64(&kernel::crypto::sha256(value.as_bytes())[..6])
}

async fn outages(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    ExaminerViewer(v): ExaminerViewer,
) -> AppResult<Json<Value>> {
    let owner = sqlx::query_scalar::<_, Uuid>("select exam_id from attempts where id=$1")
        .bind(id)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(AppError::not_found)?;
    examcore::load_exam_for_examiner(&s.db, &v, owner).await?;
    let mut conn = s.db.acquire().await?;
    let result=verified_outages(&mut conn,id).await?.into_iter().map(|gap|json!({"from":stamp(gap.from),"to":stamp(gap.to),"seconds":gap.seconds,"credited":gap.credited})).collect::<Vec<_>>();
    Ok(examcore::ok(result))
}

struct VerifiedOutage {
    from: OffsetDateTime,
    to: OffsetDateTime,
    seconds: i64,
    credited: bool,
}

// A gap is verified only when the server receives a later heartbeat. Include the start anchor and
// clip both ends to the attempt window, including a reconnect received after the deadline.
async fn verified_outages(
    conn: &mut sqlx::PgConnection,
    id: Uuid,
) -> AppResult<Vec<VerifiedOutage>> {
    let rows = sqlx::query(
        r#"
        with bounds as (
            select started_at,least(deadline_at,coalesce(submitted_at,deadline_at)) stop
            from attempts where id=$1
        ), points as (
            select started_at at from bounds
            union select at from attempt_heartbeats where attempt_id=$1
        ), gaps as (
            select lag(at) over(order by at) prev,at from points
        ), clipped as (
            select greatest(prev,started_at) lo,least(at,stop) hi
            from gaps cross join bounds where prev is not null
        )
        select lo,hi,floor(extract(epoch from (hi-lo)))::bigint seconds,
            exists(select 1 from time_credits c where c.attempt_id=$1
                and c.outage_from<hi and c.outage_to>lo) credited
        from clipped where hi-lo>=interval '45 seconds' order by lo
        "#,
    )
    .bind(id)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(VerifiedOutage {
                from: row.try_get("lo")?,
                to: row.try_get("hi")?,
                seconds: row.try_get("seconds")?,
                credited: row.try_get("credited")?,
            })
        })
        .collect()
}

async fn time_credit(
    State(s): State<AppState>,
    Path(id): Path<Uuid>,
    ExaminerViewer(v): ExaminerViewer,
    meta: RequestMeta,
    Json(input): Json<CreditInput>,
) -> AppResult<Json<Value>> {
    let exam_id = sqlx::query_scalar::<_, Uuid>("select exam_id from attempts where id=$1")
        .bind(id)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(AppError::not_found)?;
    examcore::load_exam_for_examiner(&s.db, &v, exam_id).await?;
    rate(&s, id, "time-credit", 10, 3600).await?;
    if !(1..=3600).contains(&input.seconds) {
        return Err(invalid("seconds", "Provide between 1 and 3600 seconds."));
    }
    if !(3..=500).contains(&input.reason.trim().chars().count()) || input.reason.contains('\0') {
        return Err(invalid("reason", "Provide a 3–500 character reason."));
    }
    let mut from = input
        .outage_from
        .as_deref()
        .map(|s| {
            OffsetDateTime::parse(s, &Rfc3339)
                .map_err(|_| invalid("outageFrom", "Invalid timestamp."))
        })
        .transpose()?;
    let mut to = input
        .outage_to
        .as_deref()
        .map(|s| {
            OffsetDateTime::parse(s, &Rfc3339)
                .map_err(|_| invalid("outageTo", "Invalid timestamp."))
        })
        .transpose()?;
    if from.is_some() != to.is_some() || from.zip(to).is_some_and(|(a, b)| a >= b) {
        return Err(invalid(
            "outageFrom",
            "Provide both bounds of a valid outage window.",
        ));
    }
    let mut tx = s.db.begin().await?;
    let row = sqlx::query("select status,deadline_at from attempts where id=$1 for update")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    let status: String = row.try_get("status")?;
    let deadline: OffsetDateTime = row.try_get("deadline_at")?;
    let now: OffsetDateTime = sqlx::query_scalar("select clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if status != "in_progress"
        && !(status == "expired" && now <= deadline + time::Duration::minutes(30))
    {
        return Err(examcore::conflict(
            "state",
            "Attempt is outside the recovery window.",
        ));
    }
    if !v.is_admin() {
        let gaps = verified_outages(&mut tx, id).await?;
        let total: i64 = gaps.iter().map(|gap| gap.seconds).sum();
        let granted: i64 = sqlx::query_scalar(
            "select coalesce(sum(seconds),0)::bigint from time_credits where attempt_id=$1",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let gap = gaps
            .iter()
            .filter(|gap| !gap.credited)
            .find(|gap| from.is_none_or(|a| a == gap.from) && to.is_none_or(|b| b == gap.to));
        let gap = gap.ok_or_else(|| {
            examcore::conflict("credit_cap", "A verified uncredited outage is required.")
        })?;
        // HANDOFF's strict cap and R1 pass 2: no tolerance beyond verified outage time.
        // Under this row lock overlapping requests cannot reuse a gap or exceed cumulative time.
        if i64::from(input.seconds) > gap.seconds || granted + i64::from(input.seconds) > total {
            return Err(examcore::conflict(
                "credit_cap",
                "Credit exceeds verified uncredited outage time.",
            ));
        }
        from = Some(gap.from);
        to = Some(gap.to);
    }
    let new_deadline = deadline + time::Duration::seconds(i64::from(input.seconds));
    let ends: OffsetDateTime = sqlx::query_scalar("select ends_at from exams where id=$1")
        .bind(exam_id)
        .fetch_one(&mut *tx)
        .await?;
    if new_deadline > ends + time::Duration::hours(1) {
        return Err(invalid(
            "seconds",
            "Credit would exceed the maximum exam deadline.",
        ));
    }
    sqlx::query("insert into time_credits(attempt_id,seconds,reason,outage_from,outage_to,granted_by) values($1,$2,$3,$4,$5,$6)").bind(id).bind(input.seconds).bind(input.reason.trim()).bind(from).bind(to).bind(v.id).execute(&mut *tx).await?;
    if status != "in_progress" {
        sqlx::query("update attempts set status='in_progress',finalized_by=null,submitted_at=null,deadline_at=$2 where id=$1").bind(id).bind(new_deadline).execute(&mut *tx).await?;
    } else {
        sqlx::query("update attempts set deadline_at=$2 where id=$1")
            .bind(id)
            .bind(new_deadline)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'time_credit','warning',$2)").bind(id).bind(json!({"seconds":input.seconds})).execute(&mut *tx).await?;
    tx.commit().await?;
    security::audit(
        &s.db,
        &meta,
        AuditEntry {
            action: "exam.time_credit",
            actor_id: Some(v.id),
            target_type: Some("attempt"),
            target_id: Some(id.to_string()),
            meta: json!({"seconds":input.seconds}),
        },
    )
    .await;
    Ok(examcore::ok(json!({"deadlineAt":stamp(new_deadline)})))
}

async fn bulk_credit(
    State(s): State<AppState>,
    Path(exam_id): Path<Uuid>,
    ExaminerViewer(v): ExaminerViewer,
    meta: RequestMeta,
    Json(input): Json<BulkCreditInput>,
) -> AppResult<Json<Value>> {
    examcore::load_exam_for_examiner(&s.db, &v, exam_id).await?;
    security::enforce_rate_limit(
        &s.db,
        &format!("exam-resilience:bulk-time-credit:{}", v.id),
        Limit {
            limit: 10,
            window: Duration::from_secs(3600),
        },
    )
    .await?;
    let from = OffsetDateTime::parse(&input.from, &Rfc3339)
        .map_err(|_| invalid("from", "Invalid timestamp."))?;
    let to = OffsetDateTime::parse(&input.to, &Rfc3339)
        .map_err(|_| invalid("to", "Invalid timestamp."))?;
    if from >= to || to - from > time::Duration::hours(2) {
        return Err(invalid(
            "from",
            "The outage window must be ordered and at most two hours.",
        ));
    }
    if !(3..=500).contains(&input.reason.trim().chars().count()) || input.reason.contains('\0') {
        return Err(invalid("reason", "Provide a 3–500 character reason."));
    }
    let mut tx = s.db.begin().await?;
    let window: (OffsetDateTime, OffsetDateTime) =
        sqlx::query_as("select starts_at,ends_at from exams where id=$1 for update")
            .bind(exam_id)
            .fetch_one(&mut *tx)
            .await?;
    if from < window.0 || to > window.1 {
        return Err(invalid(
            "from",
            "The outage window must be inside the exam window.",
        ));
    }
    let now: OffsetDateTime = sqlx::query_scalar("select clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let attempts: Vec<Uuid> = sqlx::query_scalar("select id from attempts where exam_id=$1 and not sandbox and (status='in_progress' or (status='expired' and deadline_at>= $2 - interval '30 minutes')) order by id for update")
        .bind(exam_id).bind(now).fetch_all(&mut *tx).await?;
    let mut credited = 0_i64;
    let mut skipped = 0_i64;
    let mut seconds_total = 0_i64;
    let mut audit_ids = Vec::new();
    for id in attempts {
        let row = sqlx::query("select status,deadline_at,started_at,least(deadline_at,coalesce(submitted_at,deadline_at)) stop from attempts where id=$1")
            .bind(id).fetch_one(&mut *tx).await?;
        let status: String = row.try_get("status")?;
        let deadline: OffsetDateTime = row.try_get("deadline_at")?;
        let started: OffsetDateTime = row.try_get("started_at")?;
        let stop: OffsetDateTime = row.try_get("stop")?;
        if status != "in_progress"
            && !(status == "expired" && now <= deadline + time::Duration::minutes(30))
        {
            skipped += 1;
            continue;
        }
        let points: Vec<OffsetDateTime> = sqlx::query_scalar("select at from (select $2::timestamptz at union select at from attempt_heartbeats where attempt_id=$1) p order by at")
            .bind(id).bind(started).fetch_all(&mut *tx).await?;
        let mut available = 0_i64;
        let mut ranges = Vec::new();
        for pair in points.windows(2) {
            let lo = std::cmp::max(std::cmp::max(pair[0], started), from);
            let hi = std::cmp::min(std::cmp::min(pair[1], stop), to);
            if pair[1] - pair[0] < time::Duration::seconds(45) || hi <= lo {
                continue;
            }
            let gap_seconds = (hi - lo).whole_seconds();
            let exact_hi = lo + time::Duration::seconds(gap_seconds);
            let credited: Vec<(OffsetDateTime, OffsetDateTime)> = sqlx::query_as("select outage_from,outage_to from time_credits where attempt_id=$1 and outage_from<$3 and outage_to>$2 order by outage_from")
                .bind(id).bind(lo).bind(exact_hi).fetch_all(&mut *tx).await?;
            let mut cursor = lo;
            for (credit_from, credit_to) in credited {
                let start = std::cmp::max(credit_from, lo);
                let end = std::cmp::min(credit_to, exact_hi);
                if start > cursor {
                    let seconds = (start - cursor).whole_seconds();
                    if seconds > 0 {
                        available += seconds;
                        ranges.push((cursor, cursor + time::Duration::seconds(seconds), seconds));
                    }
                }
                cursor = std::cmp::max(cursor, end);
            }
            if exact_hi > cursor {
                let seconds = (exact_hi - cursor).whole_seconds();
                if seconds > 0 {
                    available += seconds;
                    ranges.push((cursor, cursor + time::Duration::seconds(seconds), seconds));
                }
            }
        }
        if available <= 0 {
            skipped += 1;
            continue;
        }
        let cap = (window.1 + time::Duration::hours(1) - deadline)
            .whole_seconds()
            .max(0);
        let grant = available.min(cap);
        if grant <= 0 {
            skipped += 1;
            continue;
        }
        let mut remaining = grant;
        for (credit_from, credit_to, free) in ranges {
            if remaining <= 0 {
                break;
            }
            let this_credit = remaining.min(free);
            let credited_to = credit_from + time::Duration::seconds(this_credit);
            let bounded_to = std::cmp::min(credit_to, credited_to);
            sqlx::query("insert into time_credits(attempt_id,seconds,reason,outage_from,outage_to,granted_by) values($1,$2,$3,$4,$5,$6)")
                .bind(id).bind(i32::try_from(this_credit).map_err(|_| AppError::internal("credit exceeds storage range"))?).bind(input.reason.trim()).bind(credit_from).bind(bounded_to).bind(v.id).execute(&mut *tx).await?;
            remaining -= this_credit;
        }
        let new_deadline = deadline + time::Duration::seconds(grant);
        if status == "expired" {
            sqlx::query("update attempts set status='in_progress',finalized_by=null,submitted_at=null,deadline_at=$2 where id=$1").bind(id).bind(new_deadline).execute(&mut *tx).await?;
        } else {
            sqlx::query("update attempts set deadline_at=$2 where id=$1")
                .bind(id)
                .bind(new_deadline)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'time_credit','warning',$2)").bind(id).bind(json!({"seconds":grant,"bulk":true})).execute(&mut *tx).await?;
        credited += 1;
        seconds_total += grant;
        audit_ids.push((id, grant));
    }
    tx.commit().await?;
    for (id, seconds) in audit_ids {
        security::audit(
            &s.db,
            &meta,
            AuditEntry {
                action: "exam.time_credit",
                actor_id: Some(v.id),
                target_type: Some("attempt"),
                target_id: Some(id.to_string()),
                meta: json!({"seconds":seconds,"bulk":true}),
            },
        )
        .await;
    }
    Ok(examcore::ok(
        json!({"credited":credited,"skipped":skipped,"secondsTotal":seconds_total}),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod security_tests;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    #[test]
    fn journal_chain_fixed_vector() {
        let genesis: Vec<u8> = (0_u8..32).collect();
        let item = uuid::Uuid::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let hash = examcore::chain_next(
            &genesis,
            1,
            item,
            &serde_json::json!({"selected":["a"]}),
            1_700_000_000_000,
        );
        assert_eq!(
            examcore::b64(&hash),
            "tgxQ9Uz3atQE2HXaLEqFzwBDMs1Y21zcWeXiHNfPb5o"
        );
    }
}
