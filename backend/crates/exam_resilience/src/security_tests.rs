use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use sqlx::PgPool;
use std::{error::Error, sync::Arc};
use tower::ServiceExt;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;
const OLD: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const NEW: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";

struct Fixture {
    state: AppState,
    id: Uuid,
    item: Uuid,
    exam: Uuid,
    candidate: String,
    owner: String,
    stranger: String,
    admin: String,
}

async fn user(
    db: &PgPool,
    email: &str,
    role: &str,
) -> Result<(Uuid, String), Box<dyn Error + Send + Sync>> {
    let id: Uuid = sqlx::query_scalar("insert into users(email,role) values($1,$2) returning id")
        .bind(email)
        .bind(role)
        .fetch_one(db)
        .await?;
    let (token, hash) = kernel::crypto::new_token();
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    )
    .bind(id)
    .bind(hash.as_slice())
    .execute(db)
    .await?;
    Ok((id, token))
}

async fn fixture(db: PgPool) -> Result<Fixture, Box<dyn Error + Send + Sync>> {
    let (owner, owner_token) = user(&db, "owner@resilience.test", "examiner").await?;
    let (candidate, candidate_token) = user(&db, "candidate@resilience.test", "user").await?;
    let (_, stranger) = user(&db, "stranger@resilience.test", "examiner").await?;
    let (_, admin) = user(&db, "admin@resilience.test", "admin").await?;
    let exam:Uuid=sqlx::query_scalar("insert into exams(owner_id,title,status,starts_at,ends_at,duration_minutes,total_marks,settings) values($1,'Resilience','published',now()-interval '10 minutes',now()+interval '2 hours',120,10,'{\"allowOfflineJournal\":true}') returning id").bind(owner).fetch_one(&db).await?;
    let item:Uuid=sqlx::query_scalar("insert into exam_items(exam_id,position,topic,difficulty,kind,stem,options,correct,marks,multi_rule) values($1,0,'Timing',1,'single','Choose','[{\"id\":\"a\",\"text\":\"A\"},{\"id\":\"b\",\"text\":\"B\"}]','[\"a\"]',10,'all_or_nothing') returning id").bind(exam).fetch_one(&db).await?;
    let id:Uuid=sqlx::query_scalar("insert into attempts(exam_id,candidate_id,deadline_at,seed,item_order,journal_genesis,active_device) values($1,$2,now()+interval '1 hour',1,$3,$4,$5) returning id").bind(exam).bind(candidate).bind(vec![item]).bind(vec![7_u8;32]).bind(OLD).fetch_one(&db).await?;
    let state = AppState {
        db,
        config: Arc::new(kernel::config::Config::from_env()?),
        http: reqwest::Client::new(),
        email: Arc::new(kernel::email::LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    Ok(Fixture {
        state,
        id,
        item,
        exam,
        candidate: candidate_token,
        owner: owner_token,
        stranger,
        admin,
    })
}

async fn request(
    f: &Fixture,
    path: &str,
    method: &str,
    token: &str,
    device: &str,
    input: Value,
) -> Result<(StatusCode, Value), Box<dyn Error + Send + Sync>> {
    let app = router()
        .merge(exam_attempts::router())
        .with_state(f.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("x-attempt-device", device)
                .body(Body::from(input.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await?;
    // Standalone router extractor rejections are plain text; server middleware normalizes them.
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"extractorRejection":true}));
    Ok((status, body))
}

fn entry(
    f: &Fixture,
    seq: i64,
    prev: &[u8],
    lease: Lease,
    elapsed: i64,
    response: Value,
) -> JournalEntry {
    let written_at = lease.issued_at + elapsed;
    JournalEntry {
        seq,
        item_id: f.item,
        response: response.clone(),
        flagged: false,
        hash: examcore::b64(&examcore::chain_next(
            prev, seq, f.item, &response, written_at,
        )),
        lease,
        elapsed_ms: elapsed,
        written_at,
    }
}

async fn send(
    f: &Fixture,
    entries: Vec<JournalEntry>,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let (status, body) = request(
        f,
        &format!("/attempts/{}/journal", f.id),
        "POST",
        &f.candidate,
        OLD,
        json!({"entries":entries}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(body["data"].clone())
}

#[sqlx::test(migrations = "../../migrations")]
async fn lease_chain_time_bounds_and_replay(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let deadline = examcore::now() + time::Duration::hours(1);
    let lease = examcore::issue_lease(f.id, deadline);
    let good = entry(&f, 1, &[7; 32], lease.clone(), 0, json!({"selected":["a"]}));
    let mut forged = good.clone();
    forged.lease.mac = "forged".into();
    assert_eq!(
        send(&f, vec![forged]).await?["rejected"][0]["reason"],
        "lease"
    );
    let mut tampered = good.clone();
    tampered.response = json!({"selected":["b"]});
    assert_eq!(
        send(&f, vec![tampered]).await?["rejected"][0]["reason"],
        "chain"
    );
    let future = entry(
        &f,
        1,
        &[7; 32],
        lease.clone(),
        60_000,
        json!({"selected":["a"]}),
    );
    assert_eq!(
        send(&f, vec![future]).await?["rejected"][0]["reason"],
        "future"
    );
    let mut overflow = good.clone();
    overflow.elapsed_ms = i64::MAX;
    assert_eq!(
        send(&f, vec![overflow]).await?["rejected"][0]["reason"],
        "lease"
    );
    let mut invalid = good.clone();
    invalid.response = json!({"selected":["a","a"]});
    invalid.hash = examcore::b64(&examcore::chain_next(
        &[7; 32],
        1,
        f.item,
        &invalid.response,
        invalid.written_at,
    ));
    assert_eq!(
        send(&f, vec![invalid]).await?["rejected"][0]["reason"],
        "stale"
    );
    assert_eq!(send(&f, vec![good.clone()]).await?["accepted"], json!([1]));
    let replay = send(&f, vec![good.clone()]).await?;
    assert_eq!(replay["seq"], 1);
    assert_eq!(replay["accepted"], json!([]));
    assert_eq!(replay["head"], good.hash);
    // Reconnect must not strand online edits below the journal's high sequence range.
    let (status, body) = request(
        &f,
        &format!("/attempts/{}/answers/{}", f.id, f.item),
        "PUT",
        &f.candidate,
        OLD,
        json!({"response":{"selected":["b"]},"flagged":true,"clientSeq":1_000_000_002_i64}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["accepted"], true);
    let next = entry(
        &f,
        2,
        &examcore::unb64(&good.hash).ok_or("hash")?,
        lease,
        0,
        json!({"selected":["b"]}),
    );
    assert_eq!(send(&f, vec![next]).await?["accepted"], json!([2]));
    let (response, flagged): (Value, bool) =
        sqlx::query_as("select response,flagged from answers where attempt_id=$1")
            .bind(f.id)
            .fetch_one(&f.state.db)
            .await?;
    assert_eq!(response, json!({"selected":["b"]}));
    assert!(flagged, "equal-seq replay must not replace online metadata");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn late_entries_grace_and_broken_suffix(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let deadline = examcore::now() - time::Duration::seconds(1);
    sqlx::query("update attempts set deadline_at=$2 where id=$1")
        .bind(f.id)
        .bind(deadline)
        .execute(&f.state.db)
        .await?;
    let lease = examcore::issue_lease(f.id, examcore::now() + time::Duration::hours(1));
    let late = entry(&f, 1, &[7; 32], lease.clone(), 0, json!({"selected":["a"]}));
    let next = entry(
        &f,
        2,
        &examcore::unb64(&late.hash).ok_or("hash")?,
        lease,
        0,
        json!({"selected":["b"]}),
    );
    let result = send(&f, vec![late, next]).await?;
    assert_eq!(result["rejected"][0]["reason"], "late");
    assert_eq!(result["rejected"][1]["reason"], "chain");
    assert_eq!(result["seq"], 0);
    sqlx::query("update attempts set status='in_progress',deadline_at=now()-interval '121 seconds' where id=$1").bind(f.id).execute(&f.state.db).await?;
    let closed = entry(
        &f,
        1,
        &[7; 32],
        examcore::issue_lease(f.id, examcore::now()),
        0,
        json!({"selected":[]}),
    );
    assert_eq!(
        send(&f, vec![closed]).await?["rejected"][0]["reason"],
        "closed"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn voluntary_submit_is_final_but_timer_expiry_allows_grace_recovery(
    db: PgPool,
) -> TestResult {
    let f = fixture(db).await?;
    let lease = examcore::issue_lease(f.id, examcore::now() + time::Duration::hours(1));
    let good = entry(&f, 1, &[7; 32], lease.clone(), 0, json!({"selected":["a"]}));
    let (status, body) = request(
        &f,
        &format!("/attempts/{}/submit", f.id),
        "POST",
        &f.candidate,
        OLD,
        json!({"confirm":true}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "submitted");
    assert_eq!(
        send(&f, vec![good.clone()]).await?["rejected"][0]["reason"],
        "closed"
    );
    let count: i64 = sqlx::query_scalar("select count(*) from answers where attempt_id=$1")
        .bind(f.id)
        .fetch_one(&f.state.db)
        .await?;
    assert_eq!(count, 0);
    // Simulate an expiry shortly after the signed edit; no client timestamp or sleep is needed.
    let deadline = examcore::from_unix_ms(lease.issued_at + 1).ok_or("timestamp")?;
    sqlx::query("update attempts set status='expired',deadline_at=$2,submitted_at=clock_timestamp(),finalized_by='timer' where id=$1").bind(f.id).bind(deadline).execute(&f.state.db).await?;
    let result = send(&f, vec![good]).await?;
    assert_eq!(result["accepted"], json!([1]));
    let score: f64 = sqlx::query_scalar("select total_score::float8 from attempts where id=$1")
        .bind(f.id)
        .fetch_one(&f.state.db)
        .await?;
    assert_eq!(score, 10.0);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn bulk_credit_only_grants_verified_overlaps_and_audits(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let other: Uuid = sqlx::query_scalar(
        "insert into users(email) values('bulk-other@resilience.test') returning id",
    )
    .fetch_one(&f.state.db)
    .await?;
    let other_attempt: Uuid = sqlx::query_scalar("insert into attempts(exam_id,candidate_id,deadline_at,seed,item_order,journal_genesis) values($1,$2,now()+interval '1 hour',2,'{}',decode(repeat('00',32),'hex')) returning id").bind(f.exam).bind(other).fetch_one(&f.state.db).await?;
    let capped_candidate: Uuid = sqlx::query_scalar(
        "insert into users(email) values('bulk-capped@resilience.test') returning id",
    )
    .fetch_one(&f.state.db)
    .await?;
    let capped_attempt: Uuid = sqlx::query_scalar("insert into attempts(exam_id,candidate_id,deadline_at,seed,item_order,journal_genesis) values($1,$2,now()+interval '3 hours'-interval '10 seconds',3,'{}',decode(repeat('00',32),'hex')) returning id").bind(f.exam).bind(capped_candidate).fetch_one(&f.state.db).await?;
    sqlx::query("update attempts set started_at=now()-interval '120 seconds' where id=$1")
        .bind(f.id)
        .execute(&f.state.db)
        .await?;
    sqlx::query("update attempts set started_at=now()-interval '120 seconds' where id=$1")
        .bind(capped_attempt)
        .execute(&f.state.db)
        .await?;
    sqlx::query("insert into attempt_heartbeats(attempt_id,at) values($1,now()-interval '90 seconds'),($1,now()-interval '30 seconds')").bind(f.id).execute(&f.state.db).await?;
    sqlx::query("insert into attempt_heartbeats(attempt_id,at) values($1,now()-interval '90 seconds'),($1,now()-interval '30 seconds')").bind(capped_attempt).execute(&f.state.db).await?;
    let from = examcore::now() - time::Duration::seconds(180);
    let to = examcore::now() - time::Duration::seconds(20);
    let stamp = |x: OffsetDateTime| x.format(&Rfc3339).unwrap_or_default();
    let body = json!({"from":stamp(from),"to":stamp(to),"reason":"Regional network outage"});
    let (status, result) = request(
        &f,
        &format!("/exams/{}/outage-credit", f.exam),
        "POST",
        &f.owner,
        OLD,
        body,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["data"]["credited"], 2);
    assert_eq!(result["data"]["skipped"], 1);
    let total = result["data"]["secondsTotal"]
        .as_i64()
        .ok_or("secondsTotal")?;
    assert!((61..=70).contains(&total));
    let credits: i64 = sqlx::query_scalar(
        "select coalesce(sum(seconds),0)::bigint from time_credits where attempt_id=$1",
    )
    .bind(f.id)
    .fetch_one(&f.state.db)
    .await?;
    assert_eq!(credits, 60);
    let capped_credit: i64 = sqlx::query_scalar(
        "select coalesce(sum(seconds),0)::bigint from time_credits where attempt_id=$1",
    )
    .bind(capped_attempt)
    .fetch_one(&f.state.db)
    .await?;
    assert!((1..=10).contains(&capped_credit));
    assert_eq!(total, credits + capped_credit);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from time_credits where attempt_id=$1")
            .bind(other_attempt)
            .fetch_one(&f.state.db)
            .await?,
        0
    );
    let event: Value = sqlx::query_scalar("select detail from attempt_events where attempt_id=$1 and kind='time_credit' order by id desc limit 1").bind(f.id).fetch_one(&f.state.db).await?;
    assert_eq!(event["bulk"], true);
    let audit: Value = sqlx::query_scalar("select meta from audit_log where target_id=$1 and action='exam.time_credit' order by at desc limit 1").bind(f.id.to_string()).fetch_one(&f.state.db).await?;
    assert_eq!(audit["bulk"], true);
    let (status, _) = request(
        &f,
        &format!("/exams/{}/outage-credit", f.exam),
        "POST",
        &f.stranger,
        OLD,
        json!({"from":stamp(from),"to":stamp(to),"reason":"Regional network outage"}),
    )
    .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &f,
        &format!("/exams/{}/outage-credit", f.exam),
        "POST",
        &f.candidate,
        OLD,
        json!({"from":stamp(from),"to":stamp(to),"reason":"Regional network outage"}),
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn post_deadline_journal_requires_offline_proof_and_is_visible(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let lease = examcore::issue_lease(f.id, examcore::now() + time::Duration::hours(1));
    let deadline = examcore::from_unix_ms(lease.issued_at).ok_or("timestamp")?;
    sqlx::query("update attempts set deadline_at=$2 where id=$1")
        .bind(f.id)
        .bind(deadline)
        .execute(&f.state.db)
        .await?;
    let entry1 = entry(&f, 1, &[7; 32], lease.clone(), 0, json!({"selected":["a"]}));
    // With no heartbeat in the final 30 seconds, receipt within the local 90-second bound is accepted.
    let result = send(&f, vec![entry1]).await?;
    assert_eq!(result["accepted"], json!([1]));
    let detail: Value = sqlx::query_scalar("select detail from attempt_events where attempt_id=$1 and kind='journal_synced' order by recorded_at desc limit 1")
        .bind(f.id).fetch_one(&f.state.db).await?;
    assert_eq!(detail["lateSynced"], 1);

    // A fresh attempt with a heartbeat immediately before its deadline cannot use post-deadline grace.
    let lease2 = examcore::issue_lease(f.id, examcore::now() + time::Duration::hours(1));
    let deadline2 = examcore::from_unix_ms(lease2.issued_at).ok_or("timestamp")?;
    sqlx::query("update attempts set deadline_at=$2,journal_seq=0,journal_head=null,status='in_progress' where id=$1")
        .bind(f.id).bind(deadline2).execute(&f.state.db).await?;
    sqlx::query(
        "insert into attempt_heartbeats(attempt_id,at) values($1,$2 - interval '10 seconds')",
    )
    .bind(f.id)
    .bind(deadline2)
    .execute(&f.state.db)
    .await?;
    let entry2 = entry(&f, 1, &[7; 32], lease2, 0, json!({"selected":["a"]}));
    assert_eq!(
        send(&f, vec![entry2]).await?["rejected"][0]["reason"],
        "late"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn heartbeat_announcements_verified_outages_and_strict_inputs(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let path = format!("/attempts/{}/heartbeat", f.id);
    let examiner: Uuid = sqlx::query_scalar("select owner_id from exams where id=$1")
        .bind(f.exam)
        .fetch_one(&f.state.db)
        .await?;
    sqlx::query(
        "insert into announcements(exam_id,body,author_id) values($1,'Reconnect safely',$2)",
    )
    .bind(f.exam)
    .bind(examiner)
    .execute(&f.state.db)
    .await?;
    sqlx::query("update attempts set started_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '60 seconds' where id=$1").bind(f.id).execute(&f.state.db).await?;
    sqlx::query("insert into attempt_heartbeats(attempt_id,at) select id,last_heartbeat_at from attempts where id=$1").bind(f.id).execute(&f.state.db).await?;
    let (status, body) = request(
        &f,
        &path,
        "POST",
        &f.candidate,
        OLD,
        json!({"online":true,"pending":3,"lastAnnouncementAt":null}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["deviceActive"], true);
    assert_eq!(body["data"]["announcements"][0]["body"], "Reconnect safely");
    let lease: Lease = serde_json::from_value(body["data"]["lease"].clone())?;
    assert!(examcore::verify_lease(&lease, f.id));
    let events: i64 = sqlx::query_scalar(
        "select count(*) from attempt_events where attempt_id=$1 and kind in ('offline','online')",
    )
    .bind(f.id)
    .fetch_one(&f.state.db)
    .await?;
    assert_eq!(events, 2);
    let after = body["data"]["announcements"][0]["createdAt"].clone();
    let (_, next) = request(
        &f,
        &path,
        "POST",
        &f.candidate,
        OLD,
        json!({"online":true,"pending":0,"lastAnnouncementAt":after}),
    )
    .await?;
    assert_eq!(next["data"]["announcements"], json!([]));
    let (status, body) = request(
        &f,
        &path,
        "POST",
        &f.candidate,
        OLD,
        json!({"online":true,"pending":0,"lastAnnouncementAt":"invalid"}),
    )
    .await?;
    assert!(!status.is_success());
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    let mut e = serde_json::to_value(entry(&f, 1, &[7; 32], lease, 0, json!({"selected":[]})))?;
    e["lease"]["untrusted"] = json!(true);
    let (status, _) = request(
        &f,
        &format!("/attempts/{}/journal", f.id),
        "POST",
        &f.candidate,
        OLD,
        json!({"entries":[e]}),
    )
    .await?;
    assert!(!status.is_success());
    sqlx::query("update attempts set deadline_at=now()-interval '121 seconds' where id=$1")
        .bind(f.id)
        .execute(&f.state.db)
        .await?;
    let (_, expired) = request(
        &f,
        &path,
        "POST",
        &f.candidate,
        OLD,
        json!({"online":true,"pending":0,"lastAnnouncementAt":null}),
    )
    .await?;
    assert_eq!(expired["data"]["status"], "expired");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn takeover_blocks_old_device_and_denies_strangers(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let old_lease = examcore::issue_lease(f.id, examcore::now() + time::Duration::hours(1));
    let path = format!("/attempts/{}/takeover", f.id);
    assert_eq!(
        request(&f, &path, "POST", &f.stranger, NEW, json!({}))
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&f, &path, "POST", &f.candidate, NEW, json!({}))
            .await?
            .0,
        StatusCode::OK
    );
    let (status, body) = request(
        &f,
        &format!("/attempts/{}/answers/{}", f.id, f.item),
        "PUT",
        &f.candidate,
        OLD,
        json!({"response":{"selected":["a"]},"flagged":false,"clientSeq":1}),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["reason"], "device");
    let e = entry(&f, 1, &[7; 32], old_lease, 0, json!({"selected":["a"]}));
    let (status, body) = request(
        &f,
        &format!("/attempts/{}/journal", f.id),
        "POST",
        &f.candidate,
        OLD,
        json!({"entries":[e]}),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["reason"], "device");
    let (_, heartbeat) = request(
        &f,
        &format!("/attempts/{}/heartbeat", f.id),
        "POST",
        &f.candidate,
        OLD,
        json!({"online":true,"pending":0,"lastAnnouncementAt":null}),
    )
    .await?;
    assert_eq!(heartbeat["data"]["deviceActive"], false);
    let beats: i64 =
        sqlx::query_scalar("select count(*) from attempt_heartbeats where attempt_id=$1")
            .bind(f.id)
            .fetch_one(&f.state.db)
            .await?;
    assert_eq!(beats, 0);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn credits_require_verified_gap_and_cannot_reuse_it(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let path = format!("/attempts/{}/time-credit", f.id);
    let input = json!({"seconds":60,"reason":"Network recovery"});
    assert_eq!(
        request(&f, &path, "POST", &f.stranger, OLD, input.clone())
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, body) = request(&f, &path, "POST", &f.owner, OLD, input).await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["reason"], "credit_cap");
    sqlx::query("update attempts set started_at=date_trunc('second',now())-interval '5 minutes' where id=$1").bind(f.id).execute(&f.state.db).await?;
    // Fractional outage seconds must be floored, never rounded up into extra examination time.
    sqlx::query("insert into attempt_heartbeats(attempt_id,at) select id,started_at+interval '120.9 seconds' from attempts where id=$1").bind(f.id).execute(&f.state.db).await?;
    assert_eq!(
        request(
            &f,
            &path,
            "POST",
            &f.owner,
            OLD,
            json!({"seconds":121,"reason":"Network recovery"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    let (a, b) = tokio::join!(
        request(
            &f,
            &path,
            "POST",
            &f.owner,
            OLD,
            json!({"seconds":120,"reason":"Network recovery"})
        ),
        request(
            &f,
            &path,
            "POST",
            &f.owner,
            OLD,
            json!({"seconds":120,"reason":"Network recovery"})
        )
    );
    let statuses = [a?.0, b?.0];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 1);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let total: i64 =
        sqlx::query_scalar("select sum(seconds)::bigint from time_credits where attempt_id=$1")
            .bind(f.id)
            .fetch_one(&f.state.db)
            .await?;
    assert_eq!(total, 120);
    let (_, body) = request(
        &f,
        &format!("/attempts/{}/outages", f.id),
        "GET",
        &f.owner,
        OLD,
        json!({}),
    )
    .await?;
    assert_eq!(body["data"][0]["credited"], true);
    assert_eq!(
        request(
            &f,
            &path,
            "POST",
            &f.admin,
            OLD,
            json!({"seconds":60,"reason":"Administrative recovery"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    sqlx::query("update attempts set deadline_at=(select ends_at+interval '1 hour' from exams where id=$2) where id=$1").bind(f.id).bind(f.exam).execute(&f.state.db).await?;
    // Shared kernel currently maps VALIDATION_FAILED to 400; lead must align it to contract 422.
    assert_eq!(
        request(
            &f,
            &path,
            "POST",
            &f.admin,
            OLD,
            json!({"seconds":1,"reason":"Administrative recovery"})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    let audited: i64 =
        sqlx::query_scalar("select count(*) from audit_log where action='exam.time_credit'")
            .fetch_one(&f.state.db)
            .await?;
    assert_eq!(audited, 2);
    Ok(())
}
