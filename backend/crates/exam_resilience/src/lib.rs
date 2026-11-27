//! Failure resilient attempts: signed time leases, an ordered offline journal and audited recovery.
use axum::{Json, Router, extract::{Path, State}, http::HeaderMap, routing::{get, post}};
use examcore::{ExaminerViewer, Lease, kernel::{AppError, AppResult, AppState, Viewer, request::RequestMeta, security::{self, AuditEntry, Limit}}, invalid};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::{time::Duration, collections::HashSet};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const GRACE_SECS: i64 = 120;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/attempts/{id}/heartbeat", post(heartbeat))
        .route("/attempts/{id}/journal", post(journal))
        .route("/attempts/{id}/takeover", post(takeover))
        .route("/attempts/{id}/outages", get(outages))
        .route("/attempts/{id}/time-credit", post(time_credit))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeartbeatInput { online: bool, pending: i32, last_announcement_at: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalInput { entries: Vec<JournalEntry> }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalEntry { seq: i64, item_id: Uuid, response: Value, flagged: bool, lease: Lease, elapsed_ms: i64, written_at: i64, hash: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreditInput { seconds: i32, reason: String, outage_from: Option<String>, outage_to: Option<String> }

async fn owner_attempt(db: &sqlx::PgPool, viewer: &Viewer, id: Uuid) -> AppResult<(Uuid, Uuid)> {
    let row = sqlx::query("select a.candidate_id,a.exam_id,a.sandbox,e.owner_id from attempts a join exams e on e.id=a.exam_id where a.id=$1")
        .bind(id).fetch_optional(db).await?.ok_or_else(AppError::not_found)?;
    let candidate: Uuid = row.try_get("candidate_id")?;
    let exam: Uuid = row.try_get("exam_id")?;
    let sandbox: bool = row.try_get("sandbox")?;
    let owner: Uuid = row.try_get("owner_id")?;
    if viewer.id == candidate || (sandbox && viewer.can_examine() && (viewer.id == owner || viewer.is_admin())) { Ok((exam, candidate)) } else { Err(AppError::not_found()) }
}

fn device(headers: &HeaderMap) -> AppResult<String> {
    let value = headers.get("x-attempt-device").and_then(|v| v.to_str().ok()).unwrap_or("");
    if value.len() != 24 || !value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return Err(invalid("X-Attempt-Device", "Invalid device token.")); }
    Ok(value.to_owned())
}
fn stamp(t: OffsetDateTime) -> String { t.format(&Rfc3339).unwrap_or_default() }
async fn rate(state: &AppState, id: Uuid, action: &str, max: i32, secs: u64) -> AppResult<()> {
    security::enforce_rate_limit(&state.db, &format!("exam-resilience:{action}:{id}"), Limit { limit: max, window: Duration::from_secs(secs) }).await?;
    Ok(())
}

async fn heartbeat(State(s): State<AppState>, Path(id): Path<Uuid>, v: Viewer, headers: HeaderMap, Json(input): Json<HeartbeatInput>) -> AppResult<Json<Value>> {
    owner_attempt(&s.db, &v, id).await?;
    let device = device(&headers)?;
    if input.pending < 0 || input.pending > 100_000 { return Err(invalid("pending", "Pending count is outside the allowed range.")); }
    rate(&s, id, "heartbeat", 20, 60).await?;
    let mut tx = s.db.begin().await?;
    let row = sqlx::query("select status,deadline_at,active_device,last_heartbeat_at,now() as server_now from attempts where id=$1 for update").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let status: String = row.try_get("status")?;
    let deadline: OffsetDateTime = row.try_get("deadline_at")?;
    let active: Option<String> = row.try_get("active_device")?;
    let previous: Option<OffsetDateTime> = row.try_get("last_heartbeat_at")?;
    let now: OffsetDateTime = row.try_get("server_now")?;
    if status == "in_progress" && now > deadline + time::Duration::seconds(GRACE_SECS) { exam_attempts::finalize(&mut tx, id, "timer").await?; }
    sqlx::query("insert into attempt_heartbeats(attempt_id,at,online,pending) values($1,$2,$3,$4)").bind(id).bind(now).bind(input.online).bind(input.pending).execute(&mut *tx).await?;
    sqlx::query("update attempts set last_heartbeat_at=$2,active_device=coalesce(active_device,$3),updated_at=now() where id=$1").bind(id).bind(now).bind(&device).execute(&mut *tx).await?;
    if let Some(prev) = previous.filter(|p| now - *p >= time::Duration::seconds(45)) {
        let gap = (now - prev).whole_milliseconds().clamp(0, 86_400_000) as i32;
        sqlx::query("insert into attempt_events(attempt_id,kind,detail,duration_ms) values($1,'offline',$2,$3),($1,'online',$2,$3)").bind(id).bind(json!({"verified":true})).bind(gap).execute(&mut *tx).await?;
    }
    let after = input.last_announcement_at.and_then(|x| OffsetDateTime::parse(&x, &Rfc3339).ok());
    let announcements: Vec<Value> = sqlx::query("select id,body,created_at from announcements where exam_id=(select exam_id from attempts where id=$1) and ($2::timestamptz is null or created_at>$2) order by created_at limit 100")
        .bind(id).bind(after).fetch_all(&mut *tx).await?.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"body":r.get::<String,_>("body"),"createdAt":stamp(r.get("created_at"))})).collect();
    let status: String = sqlx::query_scalar("select status from attempts where id=$1").bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"data":{"serverNow":stamp(now),"deadlineAt":stamp(deadline),"status":status,"lease":examcore::issue_lease(id,deadline),"deviceActive":active.as_deref().is_none_or(|d| d==device),"announcements":announcements}})))
}

/// The journal lets a candidate continue through a network outage. Residual risk: while offline and
/// within the signed lease window, a candidate could consult resources; that is the same risk as an
/// online candidate. They cannot extend time because claimed times are bound to a server lease, real
/// elapsed time and the attempt deadline.
async fn journal(State(s): State<AppState>, Path(id): Path<Uuid>, v: Viewer, headers: HeaderMap, Json(input): Json<JournalInput>) -> AppResult<Json<Value>> {
    owner_attempt(&s.db, &v, id).await?;
    let requesting_device=device(&headers)?;
    rate(&s,id,"journal",30,60).await?;
    if input.entries.is_empty() || input.entries.len()>200 { return Err(invalid("entries", "Submit between 1 and 200 entries.")); }
    let mut tx=s.db.begin().await?;
    let row=sqlx::query("select a.status,a.deadline_at,a.active_device,a.journal_genesis,a.journal_head,a.journal_seq,now() as now from attempts a where a.id=$1 for update").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let mut status:String=row.try_get("status")?; let deadline:OffsetDateTime=row.try_get("deadline_at")?; let now:OffsetDateTime=row.try_get("now")?;
    let active_device:Option<String>=row.try_get("active_device")?;
    if active_device.as_deref().is_some_and(|d|d!=requesting_device) { return Err(examcore::conflict("device","This device no longer controls the attempt.")); }
    let mut head:Vec<u8>=row.try_get::<Option<Vec<u8>>,_>("journal_head")?.unwrap_or(row.try_get("journal_genesis")?);
    let mut seq:i64=row.try_get("journal_seq")?; let mut accepted=Vec::new(); let mut rejected=Vec::new(); let mut chain_broken=false;
    for entry in input.entries {
        let mut reason:Option<&str>=None;
        let lease_ok=examcore::verify_lease(&entry.lease,id) && entry.elapsed_ms>=0 && entry.written_at==entry.lease.issued_at.saturating_add(entry.elapsed_ms);
        if !lease_ok { reason=Some("lease"); }
        else if entry.written_at>examcore::unix_ms(now) { reason=Some("future"); }
        else if entry.written_at>examcore::unix_ms(deadline) || entry.written_at>entry.lease.deadline_at { reason=Some("late"); }
        else if status!="in_progress" && now>deadline+time::Duration::seconds(GRACE_SECS) { reason=Some("closed"); }
        else if chain_broken || entry.seq!=seq+1 || examcore::unb64(&entry.hash).is_none_or(|got| got!=examcore::chain_next(&head,entry.seq,entry.item_id,&entry.response,entry.written_at)) { reason=Some("chain"); chain_broken=true; }
        else {
            let item=sqlx::query("select kind,options,max_words from exam_items where id=$1 and exam_id=(select exam_id from attempts where id=$2)").bind(entry.item_id).bind(id).fetch_optional(&mut *tx).await?;
            if let Some(item)=item {
                let kind:String=item.try_get("kind")?; let options:Value=item.try_get("options")?; let max_words:Option<i32>=item.try_get("max_words")?;
                if !valid_response(&kind,&options,max_words,&entry.response) { reason=Some("stale"); }
            } else { reason=Some("stale"); }
        }
        if let Some(reason)=reason { rejected.push(json!({"seq":entry.seq,"reason":reason})); continue; }
        let written=examcore::from_unix_ms(entry.written_at).ok_or_else(||invalid("entries.writtenAt","Invalid timestamp."))?;
        // Journal seqs occupy a high range because a lease-stamped journal edit is later than every
        // online save the browser could have issued before going offline.
        let save_seq=entry.seq.checked_add(1_000_000_000).ok_or_else(||invalid("entries.seq","Sequence is too large."))?;
        exam_attempts::store::upsert_answer(&mut tx,id,entry.item_id,&entry.response,entry.flagged,save_seq,"journal",written,&json!({})).await?;
        head=examcore::chain_next(&head,entry.seq,entry.item_id,&entry.response,entry.written_at).to_vec(); seq=entry.seq; accepted.push(entry.seq);
    }
    if status=="in_progress" && now>deadline && now<=deadline+time::Duration::seconds(GRACE_SECS) { exam_attempts::finalize(&mut tx,id,"timer").await?; status="expired".into(); }
    let head_text=examcore::b64(&head);
    sqlx::query("update attempts set journal_head=$2,journal_seq=$3 where id=$1").bind(id).bind(&head).bind(seq).execute(&mut *tx).await?;
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'journal_synced',$2,$3)").bind(id).bind(if rejected.is_empty(){"info"}else{"notice"}).bind(json!({"accepted":accepted.len(),"rejected":rejected.len()})).execute(&mut *tx).await?;
    if status!="in_progress" && !accepted.is_empty() { exam_grading::autograde_attempt(&mut tx,id).await?; }
    tx.commit().await?;
    Ok(Json(json!({"data":{"accepted":accepted,"rejected":rejected,"head":head_text,"seq":seq}})))
}

fn valid_response(kind:&str,options:&Value,max_words:Option<i32>,response:&Value)->bool {
    match kind {
        "single"|"multi" => response.get("selected").and_then(Value::as_array).is_some_and(|a| { let allowed:HashSet<&str>=options.as_array().into_iter().flatten().filter_map(|v|v.get("id").and_then(Value::as_str)).collect(); let picks:Vec<&str>=a.iter().filter_map(Value::as_str).collect(); picks.len()==a.len() && picks.iter().all(|p|allowed.contains(p)) && picks.iter().collect::<HashSet<_>>().len()==picks.len() && (kind!="single" || picks.len()<=1) }),
        "written" => response.get("text").and_then(Value::as_str).is_some_and(|s|s.chars().count()<=20_000 && max_words.is_none_or(|m|s.chars().count()<=m as usize*12)),
        _ => false,
    }
}

async fn takeover(State(s):State<AppState>,Path(id):Path<Uuid>,v:Viewer,headers:HeaderMap,meta:RequestMeta)->AppResult<Json<Value>> {
    owner_attempt(&s.db,&v,id).await?; let new=device(&headers)?; rate(&s,id,"takeover",5,3600).await?;
    let mut tx=s.db.begin().await?; let row=sqlx::query("select active_device,status from attempts where id=$1 for update").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    if row.try_get::<String,_>("status")?!="in_progress" { return Err(examcore::conflict("closed","Attempt is closed.")); }
    let old:Option<String>=row.try_get("active_device")?;
    sqlx::query("update attempts set active_device=$2,device_changed_at=now() where id=$1").bind(id).bind(&new).execute(&mut *tx).await?;
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'device_takeover','warning',$2)").bind(id).bind(json!({"old":old.as_deref().map(short_hash),"new":short_hash(&new)})).execute(&mut *tx).await?;
    tx.commit().await?;
    security::audit(&s.db,&meta,AuditEntry{action:"attempt.device_takeover",actor_id:Some(v.id),target_type:Some("attempt"),target_id:Some(id.to_string()),meta:json!({})}).await;
    Ok(Json(json!({"data":{"deviceActive":true}})))
}
fn short_hash(value:&str)->String { examcore::b64(&kernel::crypto::sha256(value.as_bytes())[..6]) }

async fn outages(State(s):State<AppState>,Path(id):Path<Uuid>,ExaminerViewer(v):ExaminerViewer)->AppResult<Json<Value>> {
    let owner=sqlx::query_scalar::<_,Uuid>("select exam_id from attempts where id=$1").bind(id).fetch_optional(&s.db).await?.ok_or_else(AppError::not_found)?;
    examcore::load_exam_for_examiner(&s.db,&v,owner).await?;
    let row=sqlx::query("select a.started_at,least(a.deadline_at,coalesce(a.submitted_at,a.deadline_at)) as stop from attempts a where a.id=$1").bind(id).fetch_one(&s.db).await?;
    let from:OffsetDateTime=row.try_get("started_at")?;let to:OffsetDateTime=row.try_get("stop")?;
    let beats=sqlx::query("select at from attempt_heartbeats where attempt_id=$1 and at between $2 and $3 order by at").bind(id).bind(from).bind(to).fetch_all(&s.db).await?;
    let credits=sqlx::query("select outage_from,outage_to from time_credits where attempt_id=$1").bind(id).fetch_all(&s.db).await?;
    let mut result=Vec::new(); let mut prev=from;
    for b in beats { let at:OffsetDateTime=b.try_get("at")?; if at-prev>=time::Duration::seconds(45) { let credited=credits.iter().any(|c| { let a=c.try_get::<Option<OffsetDateTime>,_>("outage_from").ok().flatten();let z=c.try_get::<Option<OffsetDateTime>,_>("outage_to").ok().flatten();a.is_some_and(|x|x<=at)&&z.is_some_and(|x|x>=prev) }); result.push(json!({"from":stamp(prev),"to":stamp(at),"seconds":(at-prev).whole_seconds(),"credited":credited})); } prev=at; }
    Ok(Json(json!({"data":result})))
}

async fn time_credit(State(s):State<AppState>,Path(id):Path<Uuid>,v:Viewer,meta:RequestMeta,Json(input):Json<CreditInput>)->AppResult<Json<Value>> {
    let exam_id=sqlx::query_scalar::<_,Uuid>("select exam_id from attempts where id=$1").bind(id).fetch_optional(&s.db).await?.ok_or_else(AppError::not_found)?;
    let exam=examcore::load_exam_for_examiner(&s.db,&v,exam_id).await?;
    rate(&s,id,"time-credit",10,3600).await?;
    if !(v.can_examine()||v.is_admin()) { return Err(AppError::forbidden()); }
    if !(1..=3600).contains(&input.seconds)||!(3..=500).contains(&input.reason.chars().count()) { return Err(invalid("seconds", "Provide valid seconds and a 3–500 character reason.")); }
    let from=input.outage_from.as_deref().map(|s|OffsetDateTime::parse(s,&Rfc3339).map_err(|_|invalid("outageFrom","Invalid timestamp."))).transpose()?;
    let to=input.outage_to.as_deref().map(|s|OffsetDateTime::parse(s,&Rfc3339).map_err(|_|invalid("outageTo","Invalid timestamp."))).transpose()?;
    let mut tx=s.db.begin().await?; let row=sqlx::query("select status,deadline_at,now() as now from attempts where id=$1 for update").bind(id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let mut status:String=row.try_get("status")?;let deadline:OffsetDateTime=row.try_get("deadline_at")?;let now:OffsetDateTime=row.try_get("now")?;
    if status!="in_progress" && !(status=="expired" && now<=deadline+time::Duration::minutes(30)) { return Err(examcore::conflict("state","Attempt is outside the recovery window.")); }
    if !v.is_admin() {
        let allowed:i64=sqlx::query_scalar("select coalesce(sum(greatest(0,extract(epoch from (b.at-a.at))::bigint)),0) from (select at,lag(at) over(order by at) a from attempt_heartbeats where attempt_id=$1) b where b.a is not null and b.at-b.a>=interval '45 seconds' and not exists(select 1 from time_credits c where c.attempt_id=$1 and c.outage_from<=b.a and c.outage_to>=b.at)").bind(id).fetch_one(&mut *tx).await?;
        if i64::from(input.seconds)>allowed+60 { return Err(examcore::conflict("credit_cap","Credit exceeds verified uncredited outage time.")); }
    }
    let new_deadline=deadline+time::Duration::seconds(i64::from(input.seconds));
    let ends:OffsetDateTime=sqlx::query_scalar("select ends_at from exams where id=$1").bind(exam_id).fetch_one(&mut *tx).await?;
    if new_deadline>ends+time::Duration::hours(1) { return Err(invalid("seconds","Credit would exceed the maximum exam deadline.")); }
    sqlx::query("insert into time_credits(attempt_id,seconds,reason,outage_from,outage_to,granted_by) values($1,$2,$3,$4,$5,$6)").bind(id).bind(input.seconds).bind(input.reason.trim()).bind(from).bind(to).bind(v.id).execute(&mut *tx).await?;
    if status!="in_progress" { sqlx::query("update attempts set status='in_progress',finalized_by=null,submitted_at=null,deadline_at=$2 where id=$1").bind(id).bind(new_deadline).execute(&mut *tx).await?; } else { sqlx::query("update attempts set deadline_at=$2 where id=$1").bind(id).bind(new_deadline).execute(&mut *tx).await?; }
    sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'time_credit','warning',$2)").bind(id).bind(json!({"seconds":input.seconds})).execute(&mut *tx).await?;
    tx.commit().await?;
    security::audit(&s.db,&meta,AuditEntry{action:"exam.time_credit",actor_id:Some(v.id),target_type:Some("attempt"),target_id:Some(id.to_string()),meta:json!({"seconds":input.seconds})}).await;
    let _=exam;
    Ok(Json(json!({"data":{"deadlineAt":stamp(new_deadline)}})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn journal_chain_fixed_vector() {
        let genesis: Vec<u8> = (0_u8..32).collect();
        let item = uuid::Uuid::from_bytes([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
        let hash = examcore::chain_next(&genesis, 1, item, &serde_json::json!({"selected":["a"]}), 1_700_000_000_000);
        println!("journal vector: {}", examcore::b64(&hash));
    }
}
