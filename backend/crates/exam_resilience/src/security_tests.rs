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
    let body = serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await?)?;
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
    sqlx::query("insert into attempt_heartbeats(attempt_id,at) select id,started_at+interval '120 seconds' from attempts where id=$1").bind(f.id).execute(&f.state.db).await?;
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
