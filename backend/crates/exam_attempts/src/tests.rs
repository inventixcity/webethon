use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use std::{error::Error, sync::Arc};
use tower::ServiceExt;

type TestResult<T = ()> = Result<T, Box<dyn Error + Send + Sync>>;
const DEVICE: &str = "device_candidate_123";

struct Identity {
    id: Uuid,
    token: String,
}
struct Fixture {
    db: PgPool,
    state: examcore::AppState,
    candidate: Identity,
    other: Identity,
    examiner: Identity,
    exam: Uuid,
    single: Uuid,
    written: Uuid,
    multi: Uuid,
}

async fn identity(db: &PgPool, email: &str, role: &str) -> TestResult<Identity> {
    let id = sqlx::query_scalar("insert into users(email,role) values($1,$2) returning id")
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
    Ok(Identity { id, token })
}

async fn fixture(db: PgPool) -> TestResult<Fixture> {
    let candidate = identity(&db, "candidate@attempts.test", "user").await?;
    let other = identity(&db, "other@attempts.test", "user").await?;
    let examiner = identity(&db, "examiner@attempts.test", "examiner").await?;
    let settings = json!({"shuffleQuestions": true, "shuffleOptions": true, "allowOfflineJournal": true,
        "lateJoinMinutes": null, "showBreakdown": false,
        "integrity": {"watermark": true, "canary": true, "fullscreen": true}});
    let exam = sqlx::query_scalar(
        "insert into exams(owner_id,title,instructions,status,starts_at,ends_at,duration_minutes,total_marks,settings,published_at)
         values($1,'Invigil exam','Read carefully','published',now()-interval '2 minutes',now()+interval '2 hours',60,30,$2,now()) returning id",
    ).bind(examiner.id).bind(settings).fetch_one(&db).await?;
    sqlx::query("insert into enrollments(exam_id,candidate_id,extra_minutes) values($1,$2,5)")
        .bind(exam)
        .bind(candidate.id)
        .execute(&db)
        .await?;
    let mut items = Vec::new();
    for (position, kind) in ["single", "written", "multi"].iter().enumerate() {
        let (options, correct) = if *kind == "written" {
            (json!([]), json!([]))
        } else {
            (
                json!([{"id": "a", "text": "First"}, {"id": "b", "text": "Second"}]),
                json!(["a"]),
            )
        };
        items.push(sqlx::query_scalar(
            "insert into exam_items(exam_id,position,topic,difficulty,kind,stem,options,correct,marks,multi_rule,rubric,max_words,explanation)
             values($1,$2,'Security',3,$3,'Question stem',$4,$5,10,'all_or_nothing','PRIVATE RUBRIC',100,'PRIVATE EXPLANATION') returning id",
        ).bind(exam).bind(position as i32).bind(kind).bind(options).bind(correct).fetch_one(&db).await?);
    }
    let state = examcore::AppState {
        db: db.clone(),
        config: Arc::new(kernel::config::Config::from_env()?),
        http: Default::default(),
        email: Arc::new(kernel::email::LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    Ok(Fixture {
        db,
        state,
        candidate,
        other,
        examiner,
        exam,
        single: items[0],
        written: items[1],
        multi: items[2],
    })
}

async fn request(
    state: &examcore::AppState,
    token: Option<&str>,
    method: &str,
    path: &str,
    device: Option<&str>,
    body: Option<Value>,
) -> TestResult<(StatusCode, Value)> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(device) = device {
        request = request.header("x-attempt-device", device);
    }
    let response = router()
        .with_state(state.clone())
        .oneshot(
            request.body(
                body.map(|b| Body::from(b.to_string()))
                    .unwrap_or_else(Body::empty),
            )?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await?;
    let body = serde_json::from_slice(&bytes)?;
    Ok((status, body))
}

impl Fixture {
    async fn call(
        &self,
        who: &Identity,
        method: &str,
        path: &str,
        device: Option<&str>,
        body: Option<Value>,
    ) -> TestResult<(StatusCode, Value)> {
        request(&self.state, Some(&who.token), method, path, device, body).await
    }
    async fn start(&self) -> TestResult<Uuid> {
        let (status, body) = self
            .call(
                &self.candidate,
                "POST",
                &format!("/me/exams/{}/attempt", self.exam),
                Some(DEVICE),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(serde_json::from_value(body["data"]["attemptId"].clone())?)
    }
    async fn save(
        &self,
        attempt: Uuid,
        item: Uuid,
        seq: i64,
        response: Value,
    ) -> TestResult<(StatusCode, Value)> {
        self.call(
            &self.candidate,
            "PUT",
            &format!("/attempts/{attempt}/answers/{item}"),
            Some(DEVICE),
            Some(json!({"response": response, "flagged": false, "clientSeq": seq})),
        )
        .await
    }
    async fn set_deadline(&self, attempt: Uuid, deadline: OffsetDateTime) -> TestResult {
        sqlx::query("update attempts set deadline_at=$2 where id=$1")
            .bind(attempt)
            .bind(deadline)
            .execute(&self.db)
            .await?;
        Ok(())
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn non_enrolled_and_other_owners_get_404(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    for (method, path) in [
        ("GET", format!("/me/exams/{}", f.exam)),
        ("POST", format!("/me/exams/{}/attempt", f.exam)),
    ] {
        assert_eq!(
            f.call(&f.other, method, &path, Some(DEVICE), None).await?.0,
            StatusCode::NOT_FOUND
        );
    }
    let id = f.start().await?;
    for (method, path, body) in [
        ("GET", format!("/attempts/{id}"), None),
        ("GET", format!("/attempts/{id}/scratch"), None),
        (
            "PUT",
            format!("/attempts/{id}/scratch"),
            Some(json!({"text": "x", "sketch": null})),
        ),
        (
            "PUT",
            format!("/attempts/{id}/answers/{}", f.single),
            Some(json!({"response": {"selected": ["a"]}, "flagged": false, "clientSeq": 1})),
        ),
        (
            "POST",
            format!("/attempts/{id}/submit"),
            Some(json!({"confirm": true})),
        ),
    ] {
        for who in [&f.other, &f.examiner] {
            let (status, response) = f
                .call(who, method, &path, Some(DEVICE), body.clone())
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {response}");
        }
    }
    assert_eq!(
        request(&f.state, None, "GET", "/me/prefs", None, None)
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.call(&f.candidate, "GET", "/attempts/not-a-uuid", None, None)
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn start_before_window_is_refused(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("update exams set starts_at=now()+interval '1 hour',ends_at=now()+interval '3 hours' where id=$1")
        .bind(f.exam).execute(&f.db).await?;
    let (status, body) = f
        .call(
            &f.candidate,
            "POST",
            &format!("/me/exams/{}/attempt", f.exam),
            Some(DEVICE),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["reason"], "closed");
    let count: i64 = sqlx::query_scalar("select count(*) from attempts")
        .fetch_one(&f.db)
        .await?;
    assert_eq!(count, 0);
    let (_, body) = f
        .call(
            &f.candidate,
            "GET",
            &format!("/me/exams/{}", f.exam),
            None,
            None,
        )
        .await?;
    assert_eq!(body["data"]["canStart"], false);
    assert_eq!(body["data"]["access"], "upcoming");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_double_start_creates_one_attempt(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let (a, b) = tokio::join!(f.start(), f.start());
    let id = a?;
    assert_eq!(id, b?);
    let (count,): (i64,) =
        sqlx::query_as("select count(*) from attempts where exam_id=$1 and not sandbox")
            .bind(f.exam)
            .fetch_one(&f.db)
            .await?;
    assert_eq!(count, 1);
    let row = sqlx::query("select started_at,deadline_at,item_order,option_order,journal_genesis,active_device from attempts where id=$1")
        .bind(id).fetch_one(&f.db).await?;
    assert_eq!(
        (row.try_get::<OffsetDateTime, _>("deadline_at")?
            - row.try_get::<OffsetDateTime, _>("started_at")?)
        .whole_seconds(),
        65 * 60
    );
    assert_eq!(row.try_get::<Vec<Uuid>, _>("item_order")?.len(), 3);
    assert_eq!(row.try_get::<Vec<u8>, _>("journal_genesis")?.len(), 32);
    assert_eq!(
        row.try_get::<Option<String>, _>("active_device")?
            .as_deref(),
        Some(DEVICE)
    );
    let starts: i64 = sqlx::query_scalar(
        "select count(*) from attempt_events where attempt_id=$1 and kind='started'",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await?;
    assert_eq!(starts, 1);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn resume_precedes_late_join_and_preserves_device(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    sqlx::query(
        "update exams set settings=jsonb_set(settings,'{lateJoinMinutes}','0') where id=$1",
    )
    .bind(f.exam)
    .execute(&f.db)
    .await?;
    let (status, body) = f
        .call(
            &f.candidate,
            "POST",
            &format!("/me/exams/{}/attempt", f.exam),
            Some("another_device"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["attemptId"], id.to_string());
    let active: String = sqlx::query_scalar("select active_device from attempts where id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await?;
    assert_eq!(active, DEVICE);
    // An enrolled candidate without an existing attempt cannot start after the cutoff.
    sqlx::query("insert into enrollments(exam_id,candidate_id) values($1,$2)")
        .bind(f.exam)
        .bind(f.other.id)
        .execute(&f.db)
        .await?;
    assert_eq!(
        f.call(
            &f.other,
            "POST",
            &format!("/me/exams/{}/attempt", f.exam),
            Some(DEVICE),
            None
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn save_after_deadline_is_closed(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    f.set_deadline(id, examcore::now() - time::Duration::seconds(1))
        .await?;
    let (status, body) = f.save(id, f.single, 1, json!({"selected": ["a"]})).await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["reason"], "closed");
    let count: i64 = sqlx::query_scalar("select count(*) from answers")
        .fetch_one(&f.db)
        .await?;
    assert_eq!(count, 0);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn save_checks_time_after_waiting_for_row_lock(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    let mut tx = f.db.begin().await?;
    sqlx::query(
        "update attempts set deadline_at=clock_timestamp()+interval '150 milliseconds' where id=$1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let save = f.save(id, f.single, 1, json!({"selected": ["a"]}));
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        tx.commit().await
    };
    let (save, release) = tokio::join!(save, release);
    release?;
    assert_eq!(save?.1["error"]["details"]["reason"], "closed");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn stale_seq_is_ignored_and_returns_persisted_metadata(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    let (status, accepted) = f.save(id, f.single, 10, json!({"selected": ["a"]})).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["data"]["accepted"], true);
    for seq in [9, 10] {
        let (status, stale) = f
            .save(id, f.single, seq, json!({"selected": ["b"]}))
            .await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(stale["data"]["accepted"], false);
        assert_eq!(stale["data"]["clientSeq"], 10);
        assert_eq!(stale["data"]["savedAt"], accepted["data"]["savedAt"]);
    }
    let response: Value =
        sqlx::query_scalar("select response from answers where attempt_id=$1 and item_id=$2")
            .bind(id)
            .bind(f.single)
            .fetch_one(&f.db)
            .await?;
    assert_eq!(response, json!({"selected": ["a"]}));
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn wrong_or_missing_device_is_conflict(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    for device in [None, Some("another_device")] {
        let (status, body) = f
            .call(
                &f.candidate,
                "PUT",
                &format!("/attempts/{id}/answers/{}", f.single),
                device,
                Some(json!({"response": {"selected": ["a"]}, "flagged": false, "clientSeq": 1})),
            )
            .await?;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["details"]["reason"], "device");
    }
    assert_eq!(
        f.save(id, Uuid::new_v4(), 1, json!({"selected": []}))
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    Ok(())
}

fn assert_no_keys(value: &Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                assert!(
                    !["correct", "rubric", "explanation"].contains(&key.as_str()),
                    "Leaked {key}"
                );
                assert_no_keys(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                assert_no_keys(value);
            }
        }
        _ => {}
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn payload_has_no_keys_and_has_rfc3339_timestamps(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    f.save(id, f.single, 1, json!({"selected": ["a"]})).await?;
    // Even legacy/malformed option fields and responses cannot leak extra fields through the DTO.
    sqlx::query("update exam_items set options=options || '[{\"id\":\"c\",\"text\":\"Third\",\"correct\":true}]'::jsonb where id=$1")
        .bind(f.single).execute(&f.db).await?;
    sqlx::query("update answers set response=response || '{\"correct\":[\"a\"]}'::jsonb where attempt_id=$1")
        .bind(id).execute(&f.db).await?;
    sqlx::query(
        "insert into announcements(exam_id,author_id,body) values($1,$2,'Read the instructions')",
    )
    .bind(f.exam)
    .bind(f.examiner.id)
    .execute(&f.db)
    .await?;
    let (status, body) = f
        .call(
            &f.candidate,
            "GET",
            &format!("/attempts/{id}"),
            Some(DEVICE),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_no_keys(&body);
    let payload = &body["data"];
    for field in ["startedAt", "deadlineAt", "serverNow"] {
        OffsetDateTime::parse(
            payload[field].as_str().ok_or("missing timestamp")?,
            &time::format_description::well_known::Rfc3339,
        )?;
    }
    assert!(payload["answers"][0]["savedAt"].is_string());
    assert!(payload["announcements"][0]["createdAt"].is_string());
    assert_eq!(payload["deviceActive"], true);
    assert_eq!(payload["journal"]["enabled"], true);
    assert_eq!(
        examcore::unb64(
            payload["journal"]["genesis"]
                .as_str()
                .ok_or("missing genesis")?
        )
        .ok_or("invalid genesis")?
        .len(),
        32
    );
    assert!(
        payload["canary"]
            .as_str()
            .ok_or("missing canary")?
            .contains(canary_word(f.exam))
    );
    assert!(
        payload["items"]
            .as_array()
            .ok_or("missing items")?
            .iter()
            .all(|i| i["stem"].as_str().is_some_and(|s| s.contains('\u{2060}')))
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn submit_is_idempotent_and_autogrades(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    f.save(id, f.single, 1, json!({"selected": ["a"]})).await?;
    let path = format!("/attempts/{id}/submit");
    let (status, first) = f
        .call(
            &f.candidate,
            "POST",
            &path,
            None,
            Some(json!({"confirm": true})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["data"]["status"], "submitted");
    let (_, second) = f
        .call(
            &f.candidate,
            "POST",
            &path,
            None,
            Some(json!({"confirm": true})),
        )
        .await?;
    assert_eq!(first, second);
    let (score, finalizer): (f64, String) =
        sqlx::query_as("select auto_score::float8,finalized_by from attempts where id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await?;
    assert_eq!(score, 10.0);
    assert_eq!(finalizer, "candidate");
    let events: i64 = sqlx::query_scalar(
        "select count(*) from attempt_events where attempt_id=$1 and kind='submitted'",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await?;
    assert_eq!(events, 1);
    assert_eq!(
        f.save(id, f.single, 2, json!({"selected": []})).await?.1["error"]["details"]["reason"],
        "closed"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn submit_after_deadline_expires_and_workspace_refreshes_status(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    f.set_deadline(id, examcore::now() - time::Duration::seconds(1))
        .await?;
    let (_, first) = f
        .call(
            &f.candidate,
            "POST",
            &format!("/attempts/{id}/submit"),
            None,
            Some(json!({"confirm": true})),
        )
        .await?;
    assert_eq!(first["data"]["status"], "expired");
    let (_, second) = f
        .call(
            &f.candidate,
            "POST",
            &format!("/attempts/{id}/submit"),
            None,
            Some(json!({"confirm": true})),
        )
        .await?;
    assert_eq!(first, second);
    // Exercise finalization performed by a GET on a different in-progress attempt.
    sqlx::query(
        "update attempts set status='in_progress',submitted_at=null,finalized_by=null where id=$1",
    )
    .bind(id)
    .execute(&f.db)
    .await?;
    f.set_deadline(
        id,
        examcore::now() - time::Duration::seconds(JOURNAL_GRACE_SECS + 1),
    )
    .await?;
    let (status, body) = f
        .call(
            &f.candidate,
            "GET",
            &format!("/attempts/{id}"),
            Some(DEVICE),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "expired");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn sweep_respects_grace_and_skips_locked_rows(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    f.set_deadline(id, examcore::now() - time::Duration::seconds(30))
        .await?;
    assert_eq!(sweep(&f.db).await?, 0);
    f.set_deadline(
        id,
        examcore::now() - time::Duration::seconds(JOURNAL_GRACE_SECS + 10),
    )
    .await?;
    let mut tx = f.db.begin().await?;
    sqlx::query("select id from attempts where id=$1 for update")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    assert_eq!(sweep(&f.db).await?, 0);
    tx.commit().await?;
    assert_eq!(sweep(&f.db).await?, 1);
    assert_eq!(sweep(&f.db).await?, 0);
    let (status, score): (String, f64) =
        sqlx::query_as("select status,auto_score::float8 from attempts where id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await?;
    assert_eq!(status, "expired");
    assert_eq!(score, 0.0);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn scratch_and_prefs_roundtrip_and_close(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    let path = format!("/attempts/{id}/scratch");
    let (_, initial) = f.call(&f.candidate, "GET", &path, None, None).await?;
    assert_eq!(
        initial["data"],
        json!({"text": "", "sketch": null, "updatedAt": null})
    );
    let (_, saved) = f
        .call(
            &f.candidate,
            "PUT",
            &path,
            None,
            Some(json!({"text": "Rough work", "sketch": null})),
        )
        .await?;
    let (_, loaded) = f.call(&f.candidate, "GET", &path, None, None).await?;
    assert_eq!(saved, loaded);
    assert!(saved["data"]["updatedAt"].is_string());
    for who in [&f.candidate, &f.examiner] {
        let (status, prefs) = f.call(who, "GET", "/me/prefs", None, None).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(prefs["data"]["fontScale"], 1.0);
        let mut updated = prefs["data"].clone();
        updated["theme"] = json!("dark");
        assert_eq!(
            f.call(who, "PUT", "/me/prefs", None, Some(updated.clone()))
                .await?
                .1["data"],
            updated
        );
        assert_eq!(
            f.call(who, "GET", "/me/prefs", None, None).await?.1["data"],
            updated
        );
    }
    f.call(
        &f.candidate,
        "POST",
        &format!("/attempts/{id}/submit"),
        None,
        Some(json!({"confirm": true})),
    )
    .await?;
    assert_eq!(
        f.call(
            &f.candidate,
            "PUT",
            &path,
            None,
            Some(json!({"text": "Too late", "sketch": null}))
        )
        .await?
        .1["error"]["details"]["reason"],
        "closed"
    );
    assert_eq!(
        f.call(&f.candidate, "GET", &path, None, None).await?.0,
        StatusCode::OK
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn response_validation_typing_and_unknown_fields(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    for (item, response) in [
        (f.single, json!({"selected": ["a", "b"]})),
        (f.multi, json!({"selected": ["a", "a"]})),
        (f.multi, json!({"selected": ["unknown"]})),
        (f.multi, json!({"selected": [1]})),
        (f.single, json!({"selected": [], "correct": ["a"]})),
        (f.written, json!({"text": "x".repeat(1201)})),
        (f.written, json!({"text": 5})),
        (f.written, json!({"text": "x", "selected": []})),
    ] {
        let (status, body) = f.save(id, item, 1, response).await?;
        assert!(!status.is_success());
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
        assert!(body["error"]["details"].is_array());
    }
    let path = format!("/attempts/{id}/answers/{}", f.written);
    let typing = json!({"keystrokes": 10, "pastes": 1, "pastedChars": 2, "activeMs": 500});
    let input =
        json!({"response": {"text": "Answer"}, "flagged": true, "clientSeq": 2, "typing": typing});
    assert_eq!(
        f.call(
            &f.candidate,
            "PUT",
            &path,
            Some(DEVICE),
            Some(input.clone())
        )
        .await?
        .0,
        StatusCode::OK
    );
    let delta = json!({"keystrokes": 4, "pastes": 2, "pastedChars": 7, "activeMs": 250});
    let second = json!({
        "response": {"text": "Answer continued"},
        "flagged": true,
        "clientSeq": 3,
        "typing": delta
    });
    assert_eq!(
        f.call(&f.candidate, "PUT", &path, Some(DEVICE), Some(second))
            .await?
            .0,
        StatusCode::OK
    );
    let stored: Value =
        sqlx::query_scalar("select typing from answers where attempt_id=$1 and item_id=$2")
            .bind(id)
            .bind(f.written)
            .fetch_one(&f.db)
            .await?;
    assert_eq!(
        stored,
        json!({"keystrokes": 14, "pastes": 3, "pastedChars": 9, "activeMs": 750})
    );
    for patch in [
        json!({"typing": {"keystrokes": -1, "pastes": 0, "pastedChars": 0, "activeMs": 0}}),
        json!({"extra": true}),
        json!({"clientSeq": -1}),
    ] {
        let mut invalid_input = input.clone();
        for (key, value) in patch.as_object().ok_or("invalid patch")? {
            invalid_input[key] = value.clone();
        }
        let (status, body) = f
            .call(
                &f.candidate,
                "PUT",
                &path,
                Some(DEVICE),
                Some(invalid_input),
            )
            .await?;
        assert!(!status.is_success());
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    }
    assert_eq!(
        f.save(id, f.written, 3, json!({"text": ""})).await?.0,
        StatusCode::OK
    );
    Ok(())
}

#[test]
fn watermark_and_canary_are_stable_and_device_tokens_are_strict() {
    let id = Uuid::from_bytes([0x80, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
    let marked = watermark("First stem", id);
    assert!(marked.starts_with("First \u{2060}\u{200c}"));
    let visible: String = marked
        .chars()
        .filter(|c| !['\u{2060}', '\u{200b}', '\u{200c}'].contains(c))
        .collect();
    assert_eq!(visible, "First stem");
    assert_eq!(canary_word(id), canary_word(id));
    for token in ["12345678", DEVICE, &"x".repeat(64)] {
        assert!(valid_device(token));
    }
    for token in ["short", "device!123", &"x".repeat(65), "nonasciié"] {
        assert!(!valid_device(token));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn dashboard_and_lobby_share_access_rules(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    assert_eq!(dashboard["data"]["available"][0]["access"], "available");
    assert!(dashboard["data"]["serverNow"].is_string());
    sqlx::query(
        "update exams set settings=jsonb_set(settings,'{lateJoinMinutes}','0') where id=$1",
    )
    .bind(f.exam)
    .execute(&f.db)
    .await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    assert_eq!(dashboard["data"]["completed"][0]["access"], "missed");
    let (_, lobby) = f
        .call(
            &f.candidate,
            "GET",
            &format!("/me/exams/{}", f.exam),
            None,
            None,
        )
        .await?;
    assert_eq!(lobby["data"]["canStart"], false);
    assert_eq!(lobby["data"]["reason"], "late_join_closed");
    sqlx::query(
        "update exams set settings=jsonb_set(settings,'{lateJoinMinutes}','null') where id=$1",
    )
    .bind(f.exam)
    .execute(&f.db)
    .await?;
    let id = f.start().await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    assert_eq!(dashboard["data"]["available"][0]["access"], "in_progress");
    f.set_deadline(id, examcore::now() - time::Duration::seconds(1))
        .await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    assert_eq!(dashboard["data"]["available"][0]["access"], "in_progress");
    f.set_deadline(
        id,
        examcore::now() - time::Duration::seconds(JOURNAL_GRACE_SECS + 1),
    )
    .await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    assert_eq!(dashboard["data"]["completed"][0]["access"], "submitted");
    sqlx::query("update exams set results_published_at=now() where id=$1")
        .bind(f.exam)
        .execute(&f.db)
        .await?;
    let (_, dashboard) = f.call(&f.candidate, "GET", "/me/exams", None, None).await?;
    let (_, lobby) = f
        .call(
            &f.candidate,
            "GET",
            &format!("/me/exams/{}", f.exam),
            None,
            None,
        )
        .await?;
    assert_eq!(dashboard["data"]["completed"][0]["access"], "results");
    assert_eq!(lobby["data"]["access"], "results");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn revoked_hidden_or_closed_exams_cannot_start(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let path = format!("/me/exams/{}/attempt", f.exam);
    for (sql, expected) in [
        (
            "update enrollments set status='revoked' where exam_id=$1",
            StatusCode::NOT_FOUND,
        ),
        (
            "update exams set status='draft' where id=$1",
            StatusCode::NOT_FOUND,
        ),
        (
            "update exams set deleted_at=now() where id=$1",
            StatusCode::NOT_FOUND,
        ),
        (
            "update exams set starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' where id=$1",
            StatusCode::CONFLICT,
        ),
    ] {
        sqlx::query("update enrollments set status='enrolled' where exam_id=$1")
            .bind(f.exam)
            .execute(&f.db)
            .await?;
        sqlx::query("update exams set status='published',deleted_at=null where id=$1")
            .bind(f.exam)
            .execute(&f.db)
            .await?;
        sqlx::query(sql).bind(f.exam).execute(&f.db).await?;
        assert_eq!(
            f.call(&f.candidate, "POST", &path, Some(DEVICE), None)
                .await?
                .0,
            expected
        );
    }
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn accommodation_is_capped_at_exam_end_and_devices_are_validated(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("update exams set ends_at=now()+interval '10 minutes' where id=$1")
        .bind(f.exam)
        .execute(&f.db)
        .await?;
    for device in ["short", "bad!device", &"x".repeat(65)] {
        let (_, body) = f
            .call(
                &f.candidate,
                "POST",
                &format!("/me/exams/{}/attempt", f.exam),
                Some(device),
                None,
            )
            .await?;
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    }
    let id = f.start().await?;
    let (deadline, ends): (OffsetDateTime, OffsetDateTime) = sqlx::query_as(
        "select a.deadline_at,e.ends_at from attempts a join exams e on e.id=a.exam_id where a.id=$1",
    ).bind(id).fetch_one(&f.db).await?;
    assert_eq!(deadline, ends);
    Ok(())
}

async fn sandbox(f: &Fixture) -> TestResult<Uuid> {
    let mut tx = f.db.begin().await?;
    sqlx::query("delete from attempts where exam_id=$1 and sandbox")
        .bind(f.exam)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from exam_items where exam_id=$1 and sandbox")
        .bind(f.exam)
        .execute(&mut *tx)
        .await?;
    let items: Vec<Uuid> = sqlx::query_scalar(
        "insert into exam_items(exam_id,sandbox,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,max_words)
         select exam_id,true,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,max_words
         from exam_items where exam_id=$1 and not sandbox returning id",
    ).bind(f.exam).fetch_all(&mut *tx).await?;
    let id = sqlx::query_scalar(
        "insert into attempts(exam_id,candidate_id,sandbox,deadline_at,seed,item_order,journal_genesis)
         values($1,$2,true,now()+interval '1 hour',42,$3,decode(repeat('00',32),'hex')) returning id",
    ).bind(f.exam).bind(f.examiner.id).bind(items).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}

#[sqlx::test(migrations = "../../migrations")]
async fn sandbox_initializes_device_is_audited_and_reloads_replaced_snapshot(
    db: PgPool,
) -> TestResult {
    let f = fixture(db).await?;
    for _ in 0..2 {
        let id = sandbox(&f).await?;
        let path = format!("/attempts/{id}");
        assert_eq!(
            f.call(&f.candidate, "GET", &path, Some(DEVICE), None)
                .await?
                .0,
            StatusCode::NOT_FOUND
        );
        let (status, payload) = f
            .call(&f.examiner, "GET", &path, Some(DEVICE), None)
            .await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["data"]["sandbox"], true);
        assert_eq!(payload["data"]["deviceActive"], true);
        let item = &payload["data"]["items"][0];
        let response = if item["kind"] == "written" {
            json!({"text": "Sandbox"})
        } else {
            json!({"selected": ["a"]})
        };
        let (status, body) = f
            .call(
                &f.examiner,
                "PUT",
                &format!(
                    "{path}/answers/{}",
                    item["id"].as_str().ok_or("missing item")?
                ),
                Some(DEVICE),
                Some(json!({"response": response, "flagged": false, "clientSeq": 1})),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let count: i64 =
            sqlx::query_scalar("select count(*) from audit_log where actor_id=$1 and target_id=$2")
                .bind(f.examiner.id)
                .bind(id.to_string())
                .fetch_one(&f.db)
                .await?;
        assert_eq!(count, 2);
    }
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn snapshot_cache_miss_works_with_one_database_connection(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    let id = f.start().await?;
    let one = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(f.db.connect_options().as_ref().clone())
        .await?;
    let mut state = f.state.clone();
    state.db = one;
    let (status, body) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        request(
            &state,
            Some(&f.candidate.token),
            "GET",
            &format!("/attempts/{id}"),
            Some(DEVICE),
            None,
        ),
    )
    .await??;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn full_unicode_answers_and_scratch_fit_storage_and_nuls_are_validation_errors(
    db: PgPool,
) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("update exam_items set max_words=null where id=$1")
        .bind(f.written)
        .execute(&f.db)
        .await?;
    let id = f.start().await?;
    let answer = "😀".repeat(20_000);
    assert_eq!(
        f.save(id, f.written, 1, json!({"text": answer})).await?.0,
        StatusCode::OK
    );
    assert_eq!(
        f.save(id, f.written, 2, json!({"text": "😀".repeat(20_001)}))
            .await?
            .1["error"]["code"],
        "VALIDATION_FAILED"
    );
    assert_eq!(
        f.save(id, f.written, 2, json!({"text": "\0"})).await?.1["error"]["code"],
        "VALIDATION_FAILED"
    );
    let mut bytes = vec![0_u8; 299_982];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    use base64::Engine;
    let sketch = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    assert!(sketch.len() <= 400_000);
    let path = format!("/attempts/{id}/scratch");
    let (status, body) = f
        .call(
            &f.candidate,
            "PUT",
            &path,
            None,
            Some(json!({"text": "😀".repeat(50_000), "sketch": sketch})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    for input in [
        json!({"text": "\0", "sketch": null}),
        json!({"text": "x", "sketch": "data:image/png;base64,invalid"}),
        json!({"text": "x".repeat(50_001), "sketch": null}),
        json!({"text": "x", "sketch": null, "extra": true}),
    ] {
        assert_eq!(
            f.call(&f.candidate, "PUT", &path, None, Some(input))
                .await?
                .1["error"]["code"],
            "VALIDATION_FAILED"
        );
    }
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn sweep_drains_multiple_batches(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("insert into users(email) select 'batch-' || n || '@attempts.test' from generate_series(1,205) n")
        .execute(&f.db).await?;
    sqlx::query(
        "insert into attempts(exam_id,candidate_id,deadline_at,seed,item_order,journal_genesis)
         select $1,u.id,now()-interval '10 minutes',1,array[$2::uuid],decode(repeat('00',32),'hex')
         from users u where email like 'batch-%'",
    )
    .bind(f.exam)
    .bind(f.single)
    .execute(&f.db)
    .await?;
    assert_eq!(sweep(&f.db).await?, 205);
    assert_eq!(sweep(&f.db).await?, 0);
    let count: i64 = sqlx::query_scalar("select count(*) from attempts where status='expired' and auto_score=0 and grading_status='complete'")
        .fetch_one(&f.db).await?;
    assert_eq!(count, 205);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn blueprint_draw_stores_required_items_marks_and_facility(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("insert into exam_blueprints(exam_id,enabled,rows,tolerance) values($1,true,$2,0.05)")
        .bind(f.exam)
        .bind(json!([{"topic":"Security","minDifficulty":3,"maxDifficulty":3,"count":2,"marksEach":15.0}]))
        .execute(&f.db).await?;
    let mut ids = Vec::new();
    for n in 0..50 {
        let candidate: Uuid = if n == 0 {
            f.candidate.id
        } else {
            sqlx::query_scalar("insert into users(email) values($1) returning id")
                .bind(format!("blueprint-{n}@attempts.test"))
                .fetch_one(&f.db)
                .await?
        };
        if n > 0 {
            sqlx::query("insert into enrollments(exam_id,candidate_id) values($1,$2)")
                .bind(f.exam)
                .bind(candidate)
                .execute(&f.db)
                .await?;
        }
        let mut tx = f.db.begin().await?;
        ids.push(start_attempt_tx(&mut tx, f.exam, candidate, None).await?);
        tx.commit().await?;
    }
    let mut predicted = Vec::new();
    for id in ids {
        let (count, facility, marks):(i64,Option<f64>,Value)=sqlx::query_as("select cardinality(item_order)::bigint,predicted_facility::float8,item_marks from attempts where id=$1").bind(id).fetch_one(&f.db).await?;
        assert_eq!(count, 2);
        assert!(facility.is_some());
        assert_eq!(marks.as_object().map(serde_json::Map::len), Some(2));
        assert!(
            marks
                .as_object()
                .is_some_and(|m| m.values().all(|v| v.as_f64() == Some(15.0)))
        );
        predicted.push(facility.unwrap_or_default());
    }
    let spread = predicted.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - predicted.iter().copied().fold(f64::INFINITY, f64::min);
    assert!(spread <= 0.05);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
async fn blueprint_overlapping_rows_reassign_a_broad_pick(db: PgPool) -> TestResult {
    let f = fixture(db).await?;
    sqlx::query("update exam_items set difficulty=1 where id=$1")
        .bind(f.single)
        .execute(&f.db)
        .await?;
    sqlx::query("update exam_items set difficulty=2 where id=$1")
        .bind(f.written)
        .execute(&f.db)
        .await?;
    sqlx::query("update exam_items set difficulty=5 where id=$1")
        .bind(f.multi)
        .execute(&f.db)
        .await?;
    // The broad row is deliberately first. Its only useful choice for a complete assignment is
    // the difficulty-2 item, leaving the difficulty-1 item for the narrow row.
    let rows = vec![
        BlueprintDrawRow {
            topic: "Security".into(),
            min_difficulty: 1,
            max_difficulty: 2,
            count: 1,
            marks_each: 15.0,
        },
        BlueprintDrawRow {
            topic: "Security".into(),
            min_difficulty: 1,
            max_difficulty: 1,
            count: 1,
            marks_each: 15.0,
        },
    ];
    sqlx::query(
        "insert into exam_blueprints(exam_id,enabled,rows,tolerance) values($1,true,$2,0.05)",
    )
    .bind(f.exam)
    .bind(serde_json::to_value(rows)?)
    .execute(&f.db)
    .await?;
    let mut tx = f.db.begin().await?;
    let attempt = start_attempt_tx(&mut tx, f.exam, f.candidate.id, None).await?;
    tx.commit().await?;
    let order: Vec<Uuid> = sqlx::query_scalar("select item_order from attempts where id=$1")
        .bind(attempt)
        .fetch_one(&f.db)
        .await?;
    assert_eq!(order.len(), 2);
    let difficulties: Vec<i16> =
        sqlx::query_scalar("select difficulty from exam_items where id=any($1)")
            .bind(&order)
            .fetch_all(&f.db)
            .await?;
    assert!(difficulties.contains(&1));
    assert!(difficulties.contains(&2));
    Ok(())
}
