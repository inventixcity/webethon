//! Privacy-light integrity indicators and examiner monitoring routes.
use axum::{
    Router,
    extract::State,
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use kernel::{
    AppError, AppResult, AppState, Viewer,
    extract::{Json, Path, ResponseJson},
    request::RequestMeta,
    security::{AuditEntry, enforce_rate_limit},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::time::Duration;
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/attempts/{id}/events", post(events))
        .route("/attempts/{id}/integrity", get(integrity))
        .route("/exams/{id}/monitor", get(monitor))
        .route("/exams/{id}/monitor/stream", get(monitor_stream))
        .route(
            "/exams/{id}/announcements",
            get(announcements).post(create_announcement),
        )
        .route("/exams/{id}/trace", post(trace))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventBatch {
    events: Vec<EventInput>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventInput {
    kind: String,
    #[serde(with = "time::serde::rfc3339")]
    client_at: time::OffsetDateTime,
    #[serde(default)]
    duration_ms: Option<i32>,
    #[serde(default = "empty_detail")]
    detail: Value,
}
fn empty_detail() -> Value {
    json!({})
}
fn event_window_open(
    status: &str,
    deadline: time::OffsetDateTime,
    now: time::OffsetDateTime,
) -> bool {
    status == "in_progress" && now <= deadline + time::Duration::minutes(2)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnnouncementInput {
    body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceInput {
    text: String,
}

fn invalid(path: &str, message: &str) -> AppError {
    examcore::invalid(path, message)
}
const EVENT_KINDS: &[&str] = &[
    "focus_lost",
    "visibility_hidden",
    "fullscreen_exit",
    "paste",
    "copy",
    "context_menu",
    "typing_anomaly",
    "offline",
    "online",
    "announcement_seen",
];
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

pub fn canary_word(exam_id: Uuid) -> &'static str {
    let digest = kernel::crypto::sha256(exam_id.as_bytes());
    let first: [u8; 8] = digest[..8].try_into().unwrap_or([0; 8]);
    CANARY_WORDS[(u64::from_be_bytes(first) % CANARY_WORDS.len() as u64) as usize]
}

fn validate_events(events: &[EventInput]) -> AppResult<()> {
    if events.is_empty() || events.len() > 50 {
        return Err(invalid("events", "Send between 1 and 50 events."));
    }
    for (i, e) in events.iter().enumerate() {
        let path = format!("events.{i}");
        if !EVENT_KINDS.contains(&e.kind.as_str()) {
            return Err(invalid(&format!("{path}.kind"), "Unsupported event kind."));
        }
        if e.duration_ms
            .is_some_and(|d| !(0..=86_400_000).contains(&d))
        {
            return Err(invalid(
                &format!("{path}.durationMs"),
                "Duration is outside the allowed range.",
            ));
        }
        let Some(obj) = e.detail.as_object() else {
            return Err(invalid(
                &format!("{path}.detail"),
                "Detail must be an object.",
            ));
        };
        if obj.len() > 8 {
            return Err(invalid(
                &format!("{path}.detail"),
                "Use at most 8 detail fields.",
            ));
        }
        for (key, value) in obj {
            if key.is_empty() || key.len() > 24 || !key.bytes().all(|b| b.is_ascii_alphabetic()) {
                return Err(invalid(
                    &format!("{path}.detail"),
                    "Detail keys must use 1 to 24 ASCII letters.",
                ));
            }
            let valid = match value {
                Value::String(s) => s.len() <= 64,
                Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
                Value::Bool(_) => true,
                _ => false,
            };
            if !valid {
                return Err(invalid(
                    &format!("{path}.detail.{key}"),
                    "Detail values must be short strings, numbers or booleans.",
                ));
            }
        }
    }
    Ok(())
}

async fn owned_attempt(
    db: &PgPool,
    viewer: &Viewer,
    id: Uuid,
) -> AppResult<(Uuid, bool, String, time::OffsetDateTime)> {
    let row: Option<(Uuid,bool,String,time::OffsetDateTime)> = sqlx::query_as("select a.exam_id,a.sandbox,a.status,a.deadline_at from attempts a where a.id=$1 and a.candidate_id=$2").bind(id).bind(viewer.id).fetch_optional(db).await?;
    row.ok_or_else(AppError::not_found)
}
async fn events(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    viewer: Viewer,
    Json(input): Json<EventBatch>,
) -> AppResult<ResponseJson<Value>> {
    viewer.require_candidate()?;
    validate_events(&input.events)?;
    let (exam_id, sandbox, status, deadline) = owned_attempt(&state.db, &viewer, id).await?;
    if !event_window_open(&status, deadline, time::OffsetDateTime::now_utc()) {
        return Err(AppError::not_found());
    }
    enforce_rate_limit(
        &state.db,
        &format!("integrity:events:{id}"),
        kernel::security::Limit {
            limit: 30,
            window: Duration::from_secs(60),
        },
    )
    .await?;
    let mut tx = state.db.begin().await?;
    let locked: Option<(String, time::OffsetDateTime)> = sqlx::query_as(
        "select status,deadline_at from attempts where id=$1 and candidate_id=$2 for update",
    )
    .bind(id)
    .bind(viewer.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, deadline)) = locked else {
        return Err(AppError::not_found());
    };
    if !event_window_open(&status, deadline, time::OffsetDateTime::now_utc()) {
        return Err(AppError::not_found());
    }
    for e in &input.events {
        let severity = match e.kind.as_str() {
            "fullscreen_exit" => "warning",
            "paste"
                if e.detail
                    .get("pastedChars")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    >= 200 =>
            {
                "warning"
            }
            "focus_lost" if e.duration_ms.unwrap_or(0) >= 30_000 => "warning",
            "focus_lost" | "visibility_hidden" | "copy" => "notice",
            _ => "info",
        };
        sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail,duration_ms,client_at) values($1,$2,$3,$4,$5,$6)").bind(id).bind(&e.kind).bind(severity).bind(&e.detail).bind(e.duration_ms).bind(e.client_at).execute(&mut *tx).await?;
    }
    recompute_priority(&mut tx, id).await?;
    tx.commit().await?;
    let _ = (exam_id, sandbox);
    Ok(ResponseJson(
        json!({"data":{"recorded":input.events.len()}}),
    ))
}

async fn create_announcement(
    State(state): State<AppState>,
    Path(exam_id): Path<Uuid>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<AnnouncementInput>,
) -> AppResult<ResponseJson<Value>> {
    viewer.require_examiner()?;
    examcore::load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    if input.body.trim().is_empty() || input.body.chars().count() > 1000 {
        return Err(invalid("body", "Use 1 to 1000 characters."));
    }
    enforce_rate_limit(
        &state.db,
        &format!("integrity:announcement:{exam_id}:{}", viewer.id),
        kernel::security::Limit {
            limit: 10,
            window: Duration::from_secs(60),
        },
    )
    .await?;
    let mut tx = state.db.begin().await?;
    let row: (Uuid,String,time::OffsetDateTime)=sqlx::query_as("insert into announcements(exam_id,author_id,body) values($1,$2,$3) returning id,body,created_at").bind(exam_id).bind(viewer.id).bind(input.body.trim()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    kernel::security::audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "integrity.announcement",
            actor_id: Some(viewer.id),
            target_type: Some("exam"),
            target_id: Some(exam_id.to_string()),
            meta: json!({"announcementId":row.0}),
        },
    )
    .await;
    Ok(ResponseJson(
        json!({"data":{"id":row.0,"body":row.1,"createdAt":row.2}}),
    ))
}

async fn announcements(
    State(state): State<AppState>,
    Path(exam_id): Path<Uuid>,
    viewer: Viewer,
) -> AppResult<ResponseJson<Value>> {
    let allowed = if viewer.can_examine() {
        examcore::load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
        true
    } else {
        sqlx::query_scalar::<_,bool>("select exists(select 1 from enrollments where exam_id=$1 and candidate_id=$2 and status='enrolled')").bind(exam_id).bind(viewer.id).fetch_one(&state.db).await?
    };
    if !allowed {
        return Err(AppError::not_found());
    }
    let rows:Vec<(Uuid,String,time::OffsetDateTime)>=sqlx::query_as("select id,body,created_at from announcements where exam_id=$1 order by created_at desc limit 100").bind(exam_id).fetch_all(&state.db).await?;
    Ok(ResponseJson(
        json!({"data":rows.into_iter().map(|r|json!({"id":r.0,"body":r.1,"createdAt":r.2})).collect::<Vec<_>>()}),
    ))
}

async fn trace(
    State(state): State<AppState>,
    Path(exam_id): Path<Uuid>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<TraceInput>,
) -> AppResult<ResponseJson<Value>> {
    viewer.require_examiner()?;
    examcore::load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    if input.text.chars().count() > 20_000 {
        return Err(invalid("text", "Use at most 20000 characters."));
    }
    let ids = watermark_ids(&input.text);
    let mut matched = None;
    for bytes in ids {
        let row:Option<(Uuid,String,String)>=sqlx::query_as("select a.id,u.display_name,u.email from attempts a join users u on u.id=a.candidate_id where a.exam_id=$1 and substring(uuid_send(a.id) from 1 for 8)=$2 and not a.sandbox limit 1").bind(exam_id).bind(bytes.as_slice()).fetch_optional(&state.db).await?;
        if let Some((id, name, email)) = row {
            matched = Some(json!({"attemptId":id,"candidate":{"displayName":name,"email":email}}));
            break;
        }
    }
    kernel::security::audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "integrity.trace",
            actor_id: Some(viewer.id),
            target_type: Some("exam"),
            target_id: Some(exam_id.to_string()),
            meta: json!({"matched":matched.is_some()}),
        },
    )
    .await;
    Ok(ResponseJson(json!({"data":matched})))
}

async fn integrity(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    viewer: Viewer,
) -> AppResult<ResponseJson<Value>> {
    viewer.require_examiner()?;
    let owner:Option<(Uuid,Uuid,String)>=sqlx::query_as("select e.owner_id,a.exam_id,a.review_priority from attempts a join exams e on e.id=a.exam_id where a.id=$1 and not a.sandbox").bind(id).fetch_optional(&state.db).await?;
    let Some((owner, _exam_id, priority)) = owner else {
        return Err(AppError::not_found());
    };
    if owner != viewer.id && !viewer.is_admin() {
        return Err(AppError::not_found());
    }
    let events:Vec<Value>=sqlx::query_scalar("select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'severity',severity,'detail',detail,'durationMs',duration_ms,'clientAt',client_at,'recordedAt',recorded_at) order by id desc),'[]'::jsonb) from (select id,kind,severity,detail,duration_ms,client_at,recorded_at from attempt_events where attempt_id=$1 order by id desc limit 500) x").bind(id).fetch_one(&state.db).await?;
    let outages:Vec<Value>=sqlx::query_scalar("select coalesce(jsonb_agg(jsonb_build_object('from',a.at,'to',b.at,'seconds',extract(epoch from b.at-a.at)::int,'credited',exists(select 1 from time_credits c where c.attempt_id=$1 and c.outage_from<b.at and c.outage_to>a.at)) order by a.at),'[]'::jsonb) from attempt_heartbeats a join lateral (select at from attempt_heartbeats where attempt_id=a.attempt_id and at>a.at order by at limit 1) b on true where a.attempt_id=$1 and b.at-a.at>=interval '45 seconds'").bind(id).fetch_one(&state.db).await?;
    let summaries: Vec<(String, i64, i64)> = sqlx::query_as("select kind,count(*) filter(where duration_ms is not null),coalesce(sum(duration_ms) filter(where duration_ms is not null),0) from attempt_events where attempt_id=$1 and kind in ('focus_lost','visibility_hidden','fullscreen_exit','paste','copy','canary_hit','device_takeover','typing_anomaly') group by kind").bind(id).fetch_all(&state.db).await?;
    let mut indicators = Vec::new();
    for (kind, count, duration) in summaries {
        let (label, explanation, weight) = match kind.as_str() {
            "focus_lost" => (
                format!(
                    "Left the exam window {count} times (total {})",
                    duration_label(duration)
                ),
                "Focus changes are indicators for human review, not evidence of misconduct."
                    .to_owned(),
                1,
            ),
            "visibility_hidden" => (
                format!(
                    "The exam tab was hidden {count} times (total {})",
                    duration_label(duration)
                ),
                "Tab visibility changes are indicators for human review.".to_owned(),
                1,
            ),
            "fullscreen_exit" => (
                format!("Exited fullscreen {count} times"),
                "Fullscreen exits are indicators for human review.".to_owned(),
                1,
            ),
            "paste" => (
                format!("Pasted text {count} times"),
                "Only paste character counts are retained; pasted content is never collected."
                    .to_owned(),
                2,
            ),
            "copy" => (
                format!("Copied from the exam {count} times"),
                "Copy actions are indicators for human review.".to_owned(),
                0,
            ),
            "device_takeover" => (
                "The exam device changed".to_owned(),
                "Device changes are indicators for human review.".to_owned(),
                1,
            ),
            "typing_anomaly" => (
                format!("Typing counts differed from the written response {count} times"),
                "Count-only typing telemetry is an indicator for human review.".to_owned(),
                2,
            ),
            _ => (
                format!("A canary word appeared in a written answer {count} times"),
                "Canary matches support human review and are not evidence of misconduct."
                    .to_owned(),
                5,
            ),
        };
        indicators.push(json!({"key":kind,"label":label,"weight":weight,"count":count,"explanation":explanation}));
    }
    let canaries = canary_answer_count(&state.db, id).await?;
    if canaries > 0 {
        indicators.push(json!({"key":"canary_hit","label":"A canary word appeared in a written answer","weight":5,"count":canaries,"explanation":"This indicator supports human review and is not evidence of misconduct."}));
    }
    let typing_flags = typing_answer_count(&state.db, id).await?;
    if typing_flags > 0 {
        indicators.push(json!({"key":"typing_anomaly","label":"Typing counts differed from the written response","weight":2,"count":typing_flags,"explanation":"Count-only typing telemetry supports human review. It is not evidence of misconduct."}));
    }
    Ok(ResponseJson(
        json!({"data":{"attemptId":id,"reviewPriority":priority,"indicators":indicators,"events":events,"outages":outages,"disclaimer":"Indicators support human review. They are not evidence of misconduct."}}),
    ))
}

async fn monitor(
    State(state): State<AppState>,
    Path(exam_id): Path<Uuid>,
    viewer: Viewer,
) -> AppResult<ResponseJson<Value>> {
    viewer.require_examiner()?;
    let payload = monitor_snapshot(&state, &viewer, exam_id).await?;
    Ok(ResponseJson(json!({"data":payload})))
}

async fn monitor_snapshot(state: &AppState, viewer: &Viewer, exam_id: Uuid) -> AppResult<Value> {
    let exam = examcore::load_exam_for_examiner(&state.db, viewer, exam_id).await?;
    let monitor: (Value, i64, i64, i64, i64, Value) = sqlx::query_as(
        "with enrolled as (select en.candidate_id,a.id,a.status from enrollments en left join attempts a on a.exam_id=en.exam_id and a.candidate_id=en.candidate_id and not a.sandbox where en.exam_id=$1 and en.status='enrolled'), attempts_json as (select coalesce(jsonb_agg(jsonb_build_object('attemptId',a.id,'candidateId',u.id,'displayName',u.display_name,'email',u.email,'status',a.status,'startedAt',a.started_at,'deadlineAt',a.deadline_at,'answered',coalesce(ans.answered,0),'flagged',coalesce(ans.flagged,0),'total',coalesce(total.n,0),'lastHeartbeatAt',a.last_heartbeat_at,'online',coalesce(a.last_heartbeat_at>=now()-interval '40 seconds',false),'incidents',coalesce(ev.incidents,0),'reviewPriority',a.review_priority,'sandbox',false) order by a.started_at),'[]'::jsonb) rows from attempts a join users u on u.id=a.candidate_id left join lateral(select count(*) filter(where ((response->>'text') is not null and response->>'text'<>'') or jsonb_array_length(coalesce(response->'selected','[]'::jsonb))>0) answered,count(*) filter(where flagged) flagged from answers where attempt_id=a.id) ans on true left join lateral(select count(*) n from exam_items where exam_id=a.exam_id and not sandbox) total on true left join lateral(select count(*) incidents from attempt_events where attempt_id=a.id and severity in ('notice','warning')) ev on true where a.exam_id=$1 and not a.sandbox), announcement_json as (select coalesce(jsonb_agg(jsonb_build_object('id',id,'body',body,'createdAt',created_at) order by created_at desc),'[]'::jsonb) items from (select id,body,created_at from announcements where exam_id=$1 order by created_at desc limit 100) x) select j.rows,(select count(*) from enrolled),(select count(*) from enrolled where status='in_progress'),(select count(*) from enrolled where status in ('submitted','expired')),(select count(*) from enrolled where id is null),n.items from attempts_json j cross join announcement_json n"
    )
        .bind(exam_id)
    .fetch_one(&state.db)
    .await?;
    Ok(
        json!({"serverNow":examcore::iso(examcore::now()),"phase":examcore::phase(&exam.status,exam.starts_at,exam.ends_at,examcore::now()),"enrolled":monitor.1,"notStarted":monitor.4,"inProgress":monitor.2,"submitted":monitor.3,"rows":monitor.0,"announcements":monitor.5}),
    )
}

// Process-local cap; each running API process allows five simultaneous streams per examiner.
static STREAMS: OnceLock<Mutex<HashMap<Uuid, usize>>> = OnceLock::new();
struct StreamPermit(Uuid);
impl Drop for StreamPermit {
    fn drop(&mut self) {
        if let Ok(mut map) = STREAMS.get_or_init(|| Mutex::new(HashMap::new())).lock()
            && let Some(count) = map.get_mut(&self.0)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.0);
            }
        }
    }
}
fn acquire_stream(id: Uuid) -> AppResult<StreamPermit> {
    let mut map = STREAMS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| AppError::internal("monitor stream counter lock poisoned"))?;
    let count = map.entry(id).or_default();
    if *count >= 5 {
        return Err(AppError::new(
            kernel::ErrorCode::RateLimited,
            "Too many monitor streams.",
        ));
    }
    *count += 1;
    Ok(StreamPermit(id))
}
async fn monitor_stream(
    State(state): State<AppState>,
    Path(exam_id): Path<Uuid>,
    viewer: Viewer,
) -> AppResult<Response> {
    viewer.require_examiner()?;
    // Check visibility before consuming a stream slot.
    let owner: Option<Uuid> = sqlx::query_scalar("select owner_id from exams where id=$1")
        .bind(exam_id)
        .fetch_optional(&state.db)
        .await?;
    if owner != Some(viewer.id) {
        return Err(AppError::not_found());
    }
    let initial = monitor_snapshot(&state, &viewer, exam_id).await?;
    let permit = acquire_stream(viewer.id)?;
    let stream_viewer = viewer.clone();
    let owner_id = viewer.id;
    let started = tokio::time::Instant::now();
    let stream = async_stream::stream! {
        let _permit = permit;
        let mut initial_for_hash = initial.clone();
        if let Some(object) = initial_for_hash.as_object_mut() {
            object.remove("serverNow");
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        initial_for_hash.to_string().hash(&mut hasher);
        let mut previous = Some(hasher.finish());
        if let Ok(data) = serde_json::to_string(&initial) {
            yield Ok::<Event, std::convert::Infallible>(Event::default().event("snapshot").data(data));
        }
        let started = started;
        let mut check = tokio::time::interval(Duration::from_secs(3));
        check.tick().await;
        let mut recheck = tokio::time::interval(monitor_recheck_interval());
        recheck.tick().await;
        loop {
            if started.elapsed() >= Duration::from_secs(1800) { break; }
            tokio::select! {
                _ = check.tick() => {
                    let payload = match monitor_snapshot(&state, &stream_viewer, exam_id).await { Ok(value) => value, Err(_) => break };
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    let mut comparable = payload.clone();
                    if let Some(object) = comparable.as_object_mut() { object.remove("serverNow"); }
                    comparable.to_string().hash(&mut hasher);
                    let hash = hasher.finish();
                    if previous != Some(hash) {
                        previous = Some(hash);
                        if let Ok(data) = serde_json::to_string(&payload) { yield Ok::<Event, std::convert::Infallible>(Event::default().event("snapshot").data(data)); }
                    }
                },
                _ = recheck.tick() => {
                    // Re-authenticate the session and verify ownership at least once a minute.
                    let valid = monitor_authorized(&state.db, stream_viewer.session_id, owner_id, exam_id).await;
                    if !valid { break; }
                }
            }
        }
    };
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text(""))
        .into_response();
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "x-accel-buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    Ok(response)
}

async fn monitor_authorized(db: &PgPool, session_id: Uuid, owner_id: Uuid, exam_id: Uuid) -> bool {
    sqlx::query_scalar("select exists(select 1 from sessions s join users u on u.id=s.user_id join exams e on e.id=$3 where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>now() and u.status='active' and u.deleted_at is null and u.role in ('examiner','admin') and e.deleted_at is null and e.owner_id=$2)")
        .bind(session_id).bind(owner_id).bind(exam_id).fetch_one(db).await.unwrap_or(false)
}

fn monitor_recheck_interval() -> Duration {
    if cfg!(test) {
        Duration::from_millis(20)
    } else {
        Duration::from_secs(60)
    }
}

/// Whether count-only typing telemetry is unusual for a written response.
pub fn typing_flag(len: usize, typing: &Value) -> bool {
    if len < 150 {
        return false;
    }
    let pasted = typing
        .get("pastedChars")
        .and_then(Value::as_u64)
        .unwrap_or(0) as f64;
    let keys = typing
        .get("keystrokes")
        .and_then(Value::as_u64)
        .unwrap_or(0) as f64;
    pasted > 0.6 * len as f64 || keys < 0.3 * len as f64
}

/// Match a whole canary word without regard to case.
pub fn canary_hit(text: &str, word: &str) -> bool {
    let lower = text.to_lowercase();
    let needle = word.to_lowercase();
    lower.match_indices(&needle).any(|(i, found)| {
        let before = lower[..i].chars().next_back();
        let after = lower[i + found.len()..].chars().next();
        before.is_none_or(|c| !c.is_alphanumeric() && c != '_')
            && after.is_none_or(|c| !c.is_alphanumeric() && c != '_')
    })
}

fn priority_for_score(score: i64) -> &'static str {
    match score {
        0 => "none",
        1..=3 => "low",
        4..=7 => "medium",
        _ => "high",
    }
}

/// Calculate the review priority from recorded indicators, then persist it.
pub async fn recompute_priority(
    conn: &mut PgConnection,
    attempt_id: Uuid,
) -> kernel::AppResult<()> {
    let row: Option<(i64, i64, i64, i64, i64)> = sqlx::query_as(
        "select least(6, coalesce(sum(case when kind in ('focus_lost','visibility_hidden') and duration_ms > 10000 then 1 else 0 end),0)), least(4, count(*) filter (where kind='fullscreen_exit')), count(*) filter (where kind='paste' and case when detail->>'pastedChars' ~ '^[0-9]{1,9}$' then (detail->>'pastedChars')::bigint >= 200 else false end), count(*) filter (where kind='canary_hit'), count(*) filter (where kind='device_takeover') from attempt_events where attempt_id=$1"
    ).bind(attempt_id).fetch_optional(&mut *conn).await?;
    let (focus, fullscreen, paste, canary, takeover) = row.unwrap_or((0, 0, 0, 0, 0));
    let typing = typing_answer_count_conn(conn, attempt_id).await?;
    let answer_canary = canary_answer_count_conn(conn, attempt_id).await?;
    let score =
        focus + fullscreen + paste * 2 + (canary + answer_canary) * 5 + takeover + typing * 2;
    let priority = priority_for_score(score);
    sqlx::query("update attempts set review_priority=$2, updated_at=now() where id=$1")
        .bind(attempt_id)
        .bind(priority)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn canary_answer_count(db: &PgPool, attempt_id: Uuid) -> AppResult<i64> {
    let mut conn = db.acquire().await?;
    canary_answer_count_conn(&mut conn, attempt_id).await
}

async fn canary_answer_count_conn(conn: &mut PgConnection, attempt_id: Uuid) -> AppResult<i64> {
    let row: Option<(Uuid, bool)> = sqlx::query_as("select a.exam_id, coalesce((e.settings->'integrity'->>'canary')::boolean,false) from attempts a join exams e on e.id=a.exam_id where a.id=$1 and not a.sandbox")
        .bind(attempt_id).fetch_optional(&mut *conn).await?;
    let Some((exam_id, enabled)) = row else {
        return Ok(0);
    };
    if !enabled {
        return Ok(0);
    }
    let word = canary_word(exam_id);
    let answers: Vec<String> = sqlx::query_scalar("select response->>'text' from answers a join exam_items i on i.id=a.item_id where a.attempt_id=$1 and i.kind='written' and response ? 'text'")
        .bind(attempt_id).fetch_all(&mut *conn).await?;
    Ok(answers.iter().filter(|text| canary_hit(text, word)).count() as i64)
}

async fn typing_answer_count(db: &PgPool, attempt_id: Uuid) -> AppResult<i64> {
    let mut conn = db.acquire().await?;
    typing_answer_count_conn(&mut conn, attempt_id).await
}

async fn typing_answer_count_conn(conn: &mut PgConnection, attempt_id: Uuid) -> AppResult<i64> {
    let answers: Vec<(String, Value)> = sqlx::query_as("select a.response->>'text',a.typing from answers a join exam_items i on i.id=a.item_id where a.attempt_id=$1 and i.kind='written' and jsonb_typeof(a.response->'text')='string'")
        .bind(attempt_id).fetch_all(&mut *conn).await?;
    Ok(answers
        .iter()
        .filter(|(text, telemetry)| typing_flag(text.chars().count(), telemetry))
        .count() as i64)
}

fn duration_label(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1000;
    format!("{}m {}s", seconds / 60, seconds % 60)
}

/// Return first-eight-byte watermark payloads found between U+2060 markers.
pub fn watermark_ids(text: &str) -> Vec<[u8; 8]> {
    let mut out = Vec::new();
    let mut framed = false;
    let mut bits = Vec::with_capacity(64);
    for ch in text.chars() {
        if ch == '\u{2060}' {
            if framed && bits.len() == 64 {
                let mut bytes = [0_u8; 8];
                for (i, bit) in bits.iter().enumerate() {
                    bytes[i / 8] |= *bit << (7 - i % 8);
                }
                out.push(bytes);
            }
            framed = !framed;
            bits.clear();
        } else if framed && (ch == '\u{200b}' || ch == '\u{200c}') && bits.len() < 65 {
            bits.push(u8::from(ch == '\u{200c}'));
        } else if framed {
            bits.clear();
            framed = false;
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn monitor_recheck_closes_on_session_revocation_or_owner_change(db: PgPool) {
        let owner: Uuid = sqlx::query_scalar("insert into users(email,role) values('stream-owner@test.invalid','examiner') returning id")
            .fetch_one(&db).await.unwrap();
        let other: Uuid = sqlx::query_scalar("insert into users(email,role) values('stream-other@test.invalid','examiner') returning id")
            .fetch_one(&db).await.unwrap();
        let (token, hash) = kernel::crypto::new_token();
        let _ = token;
        let session: Uuid = sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id")
            .bind(owner).bind(hash.as_slice()).fetch_one(&db).await.unwrap();
        let exam: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,status,starts_at,ends_at,duration_minutes,total_marks) values($1,'Stream authorization','published',now()-interval '1 hour',now()+interval '1 hour',60,10) returning id")
            .bind(owner).fetch_one(&db).await.unwrap();
        assert!(monitor_authorized(&db, session, owner, exam).await);
        let response = open_monitor_stream(db.clone(), owner, session, exam).await;
        let mut revoked_stream = response.into_body().into_data_stream();
        let _initial = tokio::time::timeout(
            Duration::from_secs(2),
            futures_util::StreamExt::next(&mut revoked_stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        sqlx::query("update sessions set revoked_at=now() where id=$1")
            .bind(session)
            .execute(&db)
            .await
            .unwrap();
        assert!(!monitor_authorized(&db, session, owner, exam).await);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(2),
                futures_util::StreamExt::next(&mut revoked_stream)
            )
            .await
            .unwrap()
            .is_none()
        );
        sqlx::query("update sessions set revoked_at=null where id=$1")
            .bind(session)
            .execute(&db)
            .await
            .unwrap();
        let response = open_monitor_stream(db.clone(), owner, session, exam).await;
        let mut reassigned_stream = response.into_body().into_data_stream();
        let _initial = tokio::time::timeout(
            Duration::from_secs(2),
            futures_util::StreamExt::next(&mut reassigned_stream),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        sqlx::query("update exams set owner_id=$2 where id=$1")
            .bind(exam)
            .bind(other)
            .execute(&db)
            .await
            .unwrap();
        assert!(!monitor_authorized(&db, session, owner, exam).await);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(2),
                futures_util::StreamExt::next(&mut reassigned_stream)
            )
            .await
            .unwrap()
            .is_none()
        );
    }

    async fn open_monitor_stream(
        db: PgPool,
        owner: Uuid,
        session_id: Uuid,
        exam: Uuid,
    ) -> axum::response::Response {
        use axum::body::Body;
        use axum::http::Request;
        use kernel::{email::LogSender, viewer::Role};
        use std::sync::Arc;
        use tower::ServiceExt;
        let state = AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let mut request = Request::get(format!("/exams/{exam}/monitor/stream"))
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(Viewer {
            id: owner,
            session_id,
            email: "stream-owner@test.invalid".into(),
            display_name: "Stream owner".into(),
            role: Role::Examiner,
            via_cookie: false,
        });
        router().with_state(state).oneshot(request).await.unwrap()
    }
    #[test]
    fn validates_indicator_helpers_and_thresholds() {
        assert!(canary_hit("Use APRICITY now", "apricity"));
        assert!(!canary_hit("apricityx", "apricity"));
        assert!(typing_flag(
            200,
            &serde_json::json!({"pastedChars":121,"keystrokes":200})
        ));
        assert!(!typing_flag(
            149,
            &serde_json::json!({"pastedChars":1000,"keystrokes":0})
        ));
        assert_eq!(
            watermark_ids("x\u{2060}\u{200c}\u{200b}"),
            Vec::<[u8; 8]>::new()
        );
        assert_eq!(priority_for_score(0), "none");
        assert_eq!(priority_for_score(3), "low");
        assert_eq!(priority_for_score(4), "medium");
        assert_eq!(priority_for_score(8), "high");
        let id = Uuid::from_bytes([0x80, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
        let framed = format!(
            "\u{2060}{}\u{2060}",
            id.as_bytes()[..8]
                .iter()
                .flat_map(|b| (0..8).rev().map(move |i| if (b >> i) & 1 == 0 {
                    '\u{200b}'
                } else {
                    '\u{200c}'
                }))
                .collect::<String>()
        );
        assert_eq!(watermark_ids(&framed), vec![[0x80, 1, 2, 3, 4, 5, 6, 7]]);
    }

    #[test]
    fn event_validation_enforces_batch_detail_and_duration_limits() {
        let event = |detail: Value, duration_ms: Option<i32>| EventInput {
            kind: "paste".into(),
            client_at: time::OffsetDateTime::now_utc(),
            duration_ms,
            detail,
        };
        assert!(validate_events(&[event(json!({"pastedChars": 200}), Some(0))]).is_ok());
        assert!(validate_events(&[event(json!({"bad-key": true}), None)]).is_err());
        assert!(validate_events(&[event(json!({"nested": []}), None)]).is_err());
        assert!(validate_events(&[event(json!({"x": "a".repeat(65)}), None)]).is_err());
        assert!(validate_events(&[event(json!({}), Some(86_400_001))]).is_err());
        assert!(validate_events(&vec![event(json!({}), None); 51]).is_err());
        let deadline = time::OffsetDateTime::now_utc();
        assert!(event_window_open(
            "in_progress",
            deadline,
            deadline + time::Duration::minutes(2)
        ));
        assert!(!event_window_open("submitted", deadline, deadline));
        assert!(!event_window_open(
            "in_progress",
            deadline,
            deadline + time::Duration::minutes(2) + time::Duration::nanoseconds(1)
        ));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn candidate_cannot_read_examiner_monitor(db: PgPool) {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use kernel::{email::LogSender, viewer::Role};
        use std::sync::Arc;
        use tower::ServiceExt;
        let state = AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let candidate = Viewer {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            email: "candidate@example.test".into(),
            display_name: "Candidate".into(),
            role: Role::User,
            via_cookie: false,
        };
        let mut request = Request::get(format!("/exams/{}/monitor/stream", Uuid::new_v4()))
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(candidate);
        let response = router()
            .with_state(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn monitor_includes_real_attempts_and_excludes_sandbox(db: PgPool) {
        use axum::{
            body::{Body, to_bytes},
            http::{Request, StatusCode},
        };
        use kernel::{email::LogSender, viewer::Role};
        use std::sync::Arc;
        use tower::ServiceExt;
        let owner: Uuid = sqlx::query_scalar("insert into users(email,role) values('monitor-owner@example.test','examiner') returning id")
            .fetch_one(&db).await.unwrap();
        let candidate: Uuid = sqlx::query_scalar(
            "insert into users(email) values('monitor-candidate@example.test') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let exam: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,status,starts_at,ends_at,duration_minutes,total_marks) values($1,'Monitor test','published',now()-interval '1 hour',now()+interval '1 hour',60,10) returning id")
            .bind(owner).fetch_one(&db).await.unwrap();
        sqlx::query("insert into enrollments(exam_id,candidate_id,enrolled_by) values($1,$2,$3)")
            .bind(exam)
            .bind(candidate)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        for sandbox in [false, true] {
            sqlx::query("insert into attempts(exam_id,candidate_id,sandbox,deadline_at,seed,item_order,journal_genesis) values($1,$2,$3,now()+interval '1 hour',1,'{}',decode(repeat('00',32),'hex'))")
                .bind(exam).bind(candidate).bind(sandbox).execute(&db).await.unwrap();
        }
        let state = AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let viewer = Viewer {
            id: owner,
            session_id: Uuid::new_v4(),
            email: "monitor-owner@example.test".into(),
            display_name: "Owner".into(),
            role: Role::Examiner,
            via_cookie: false,
        };
        let mut request = Request::get(format!("/exams/{exam}/monitor"))
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(viewer);
        let response = router()
            .with_state(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"]["rows"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["data"]["rows"][0]["sandbox"], false);
        assert_eq!(value["data"]["inProgress"], 1);

        let app = router().with_state(state.clone());
        let mut stream_request = Request::get(format!("/exams/{exam}/monitor/stream"))
            .body(Body::empty())
            .unwrap();
        stream_request.extensions_mut().insert(Viewer {
            id: owner,
            session_id: Uuid::new_v4(),
            email: "monitor-owner@example.test".into(),
            display_name: "Owner".into(),
            role: Role::Examiner,
            via_cookie: false,
        });
        let stream_response = app.clone().oneshot(stream_request).await.unwrap();
        assert_eq!(stream_response.status(), StatusCode::OK);
        assert_eq!(
            stream_response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok()),
            Some("text/event-stream")
        );
        let mut chunks = stream_response.into_body().into_data_stream();
        let frame = tokio::time::timeout(
            Duration::from_secs(2),
            futures_util::StreamExt::next(&mut chunks),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let frame = String::from_utf8(frame.to_vec()).unwrap();
        assert!(frame.contains("event: snapshot"));
        let data = frame
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let snapshot: Value = serde_json::from_str(data).unwrap();
        assert_eq!(snapshot["rows"].as_array().map(Vec::len), Some(1));
        assert_eq!(snapshot["inProgress"], 1);

        let mut stranger_request = Request::get(format!("/exams/{exam}/monitor/stream"))
            .body(Body::empty())
            .unwrap();
        stranger_request.extensions_mut().insert(Viewer {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            email: "stranger@example.test".into(),
            display_name: "Stranger".into(),
            role: Role::Examiner,
            via_cookie: false,
        });
        let denied = router()
            .with_state(state)
            .oneshot(stranger_request)
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    }
}
