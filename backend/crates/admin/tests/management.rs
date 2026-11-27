#![allow(clippy::unwrap_used)]
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{AppState, config::Config, email::LogSender};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn request(state: &AppState, token: &str, method: &str, path: &str) -> (StatusCode, Value) {
    let response = admin::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn user(db: &sqlx::PgPool, role: &str, email: &str) -> (Uuid, String, Uuid) {
    let id: Uuid = sqlx::query_scalar("insert into users(email,role) values($1,$2) returning id")
        .bind(email)
        .bind(role)
        .fetch_one(db)
        .await
        .unwrap();
    let (token, hash) = kernel::crypto::new_token();
    let session:Uuid=sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(id).bind(hash.as_slice()).fetch_one(db).await.unwrap();
    (id, token, session)
}
#[sqlx::test(migrations = "../../migrations")]
async fn management_access_actions_and_paging(db: sqlx::PgPool) {
    let (_, admin, session) = user(&db, "admin", "manager@example.test").await;
    let (owner, normal, _) = user(&db, "user", "owner@example.test").await;
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let place:Uuid=sqlx::query_scalar("insert into places(owner_id,name,lat,lng,visibility) values($1,'Park',0,0,'public') returning id").bind(owner).fetch_one(&db).await.unwrap();
    let failed:Uuid=sqlx::query_scalar("insert into jobs(kind,payload,status,last_error) values('mail','{\"secret\":\"hidden\"}','failed','private error') returning id").fetch_one(&db).await.unwrap();
    let queued: Uuid =
        sqlx::query_scalar("insert into jobs(kind,payload) values('mail','{}') returning id")
            .fetch_one(&db)
            .await
            .unwrap();
    for (method, path) in [
        ("GET", "/places".to_string()),
        ("GET", "/jobs".to_string()),
        ("POST", format!("/places/{place}/hide")),
        ("POST", format!("/jobs/{failed}/retry")),
        ("POST", format!("/jobs/{queued}/cancel")),
    ] {
        assert_eq!(
            request(&state, &normal, method, &path).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let guarded = [
        format!("/places/{place}/hide"),
        format!("/places/{place}/unhide"),
        format!("/jobs/{failed}/retry"),
        format!("/jobs/{queued}/cancel"),
    ];
    for path in &guarded {
        assert_eq!(
            request(&state, &admin, "POST", path).await.0,
            StatusCode::PRECONDITION_REQUIRED,
            "{path}"
        );
    }
    let retry = format!("/jobs/{failed}/retry");
    assert_eq!(
        request(&state, &admin, "POST", &retry).await.0,
        StatusCode::PRECONDITION_REQUIRED
    );
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()-interval '1 minute',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    assert_eq!(
        request(&state, &admin, "POST", &retry).await.0,
        StatusCode::PRECONDITION_REQUIRED
    );
    for path in &guarded {
        assert_eq!(
            request(&state, &admin, "POST", path).await.0,
            StatusCode::PRECONDITION_REQUIRED,
            "{path}"
        );
    }
    sqlx::query(
        "update admin_step_up set expires_at=now()+interval '10 minutes' where session_id=$1",
    )
    .bind(session)
    .execute(&db)
    .await
    .unwrap();
    let (status, first) = request(&state, &admin, "GET", "/jobs?kind=mail&limit=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["data"].as_array().unwrap().len(), 1);
    assert!(!first.to_string().contains("private error"));
    assert!(!first.to_string().contains("secret"));
    let cursor = first["meta"]["nextCursor"].as_str().unwrap();
    let (_, second) = request(
        &state,
        &admin,
        "GET",
        &format!("/jobs?kind=mail&limit=1&cursor={cursor}"),
    )
    .await;
    assert_ne!(first["data"][0]["id"], second["data"][0]["id"]);
    assert_eq!(
        request(&state, &admin, "GET", "/jobs?limit=101").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&state, &admin, "POST", &retry).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&state, &admin, "POST", &retry).await.0,
        StatusCode::CONFLICT
    );
    let cancel = format!("/jobs/{queued}/cancel");
    assert_eq!(
        request(&state, &admin, "POST", &cancel).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&state, &admin, "POST", &cancel).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&state, &admin, "POST", &format!("/places/{place}/hide"))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let (_, places) = request(&state, &admin, "GET", "/places?hidden=true&q=Park&limit=1").await;
    assert_eq!(places["data"][0]["id"], place.to_string());
    assert_eq!(
        request(&state, &admin, "POST", &format!("/places/{place}/unhide"))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let audit:Vec<Value>=sqlx::query_scalar("select meta from audit_log where action like 'admin.jobs.%' or action like 'admin.places.%'").fetch_all(&db).await.unwrap();
    assert_eq!(audit.len(), 4);
    for row in audit {
        assert!(row.get("before").is_some());
        assert!(row.get("after").is_some());
        assert!(!row.to_string().contains("secret"));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn public_hidden_places_and_job_conflicts(db: sqlx::PgPool) {
    let (_, admin, session) = user(&db, "admin", "admin2@example.test").await;
    let (owner, owner_token, _) = user(&db, "user", "owner2@example.test").await;
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    let place: Uuid = sqlx::query_scalar("insert into places(owner_id,name,lat,lng,visibility) values($1,'Hidden test',0,0,'public') returning id").bind(owner).fetch_one(&db).await.unwrap();
    let public = |path: String, token: Option<String>| {
        let app = places::router().with_state(state.clone());
        async move {
            let mut req = Request::get(path);
            if let Some(t) = token {
                req = req.header("authorization", format!("Bearer {t}"));
            }
            let response = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
            (status, String::from_utf8(body.to_vec()).unwrap())
        }
    };
    assert_eq!(
        public(format!("/places/{place}"), None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(&state, &admin, "POST", &format!("/places/{place}/hide"))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        public(format!("/places/{place}"), None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        public(format!("/places/{place}"), Some(owner_token))
            .await
            .0,
        StatusCode::OK
    );
    for path in [
        "/places?bbox=-1,-1,1,1",
        "/places/nearby?lat=0&lng=0&radiusKm=5",
    ] {
        let (status, body) = public(path.into(), None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(!body.contains(&place.to_string()));
    }
    assert_eq!(
        request(&state, &admin, "POST", &format!("/places/{place}/unhide"))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        public(format!("/places/{place}"), None).await.0,
        StatusCode::OK
    );
    let failed: Uuid = sqlx::query_scalar("insert into jobs(kind,payload,status,dedupe_key,attempts) values('dedupe','{}','failed','same',2) returning id").fetch_one(&db).await.unwrap();
    sqlx::query(
        "insert into jobs(kind,payload,status,dedupe_key) values('dedupe','{}','queued','same')",
    )
    .execute(&db)
    .await
    .unwrap();
    let retry = format!("/jobs/{failed}/retry");
    assert_eq!(
        request(&state, &admin, "POST", &retry).await.0,
        StatusCode::CONFLICT
    );
    let row: (String, i32) = sqlx::query_as("select status,attempts from jobs where id=$1")
        .bind(failed)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(row, ("failed".into(), 2));
    let count: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action='admin.jobs.retry' and target_id=$1",
    )
    .bind(failed.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn job_transition_matrix_and_race(db: sqlx::PgPool) {
    let (_, token, session) = user(&db, "admin", "matrix@example.test").await;
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    for operation in ["retry", "cancel"] {
        for status in ["queued", "running", "done", "failed", "dead"] {
            let id: Uuid = sqlx::query_scalar("insert into jobs(kind,payload,status,attempts) values('matrix','{}',$1,2) returning id").bind(status).fetch_one(&db).await.unwrap();
            let allowed = (operation == "retry" && ["failed", "dead"].contains(&status))
                || (operation == "cancel" && status == "queued");
            let result = request(&state, &token, "POST", &format!("/jobs/{id}/{operation}"))
                .await
                .0;
            assert_eq!(
                result,
                if allowed {
                    StatusCode::NO_CONTENT
                } else {
                    StatusCode::CONFLICT
                },
                "{status} {operation}"
            );
            let (actual, attempts): (String, i32) =
                sqlx::query_as("select status,attempts from jobs where id=$1")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            let expected = if allowed {
                if operation == "retry" {
                    "queued"
                } else {
                    "dead"
                }
            } else {
                status
            };
            assert_eq!(actual, expected);
            assert_eq!(
                attempts,
                if allowed && operation == "retry" {
                    0
                } else {
                    2
                }
            );
            let audits: Vec<Value> = sqlx::query_scalar(
                "select meta from audit_log where target_type='job' and target_id=$1",
            )
            .bind(id.to_string())
            .fetch_all(&db)
            .await
            .unwrap();
            assert_eq!(audits.len(), usize::from(allowed));
            if allowed {
                assert_eq!(audits[0]["before"]["status"], status);
                assert_eq!(audits[0]["after"]["status"], expected);
            }
        }
    }
    let id: Uuid = sqlx::query_scalar(
        "insert into jobs(kind,payload,status) values('race','{}','failed') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let retry = format!("/jobs/{id}/retry");
    let cancel = format!("/jobs/{id}/cancel");
    let (a, b) = tokio::join!(
        request(&state, &token, "POST", &retry),
        request(&state, &token, "POST", &cancel)
    );
    assert_eq!(a.0, StatusCode::NO_CONTENT);
    assert!([StatusCode::NO_CONTENT, StatusCode::CONFLICT].contains(&b.0));
    let status: String = sqlx::query_scalar("select status from jobs where id=$1")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        status,
        if b.0 == StatusCode::NO_CONTENT {
            "dead"
        } else {
            "queued"
        }
    );
    let count: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where target_type='job' and target_id=$1",
    )
    .bind(id.to_string())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, if b.0 == StatusCode::NO_CONTENT { 2 } else { 1 });
}

#[sqlx::test(migrations = "../../migrations")]
async fn places_pagination_and_audit_failure_rolls_back(db: sqlx::PgPool) {
    let (owner, token, session) = user(&db, "admin", "places-matrix@example.test").await;
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    let ids: Vec<Uuid> = sqlx::query_scalar("insert into places(owner_id,name,lat,lng,visibility) select $1,'Page place',0,0,'public' from generate_series(1,3) returning id").bind(owner).fetch_all(&db).await.unwrap();
    let mut found = Vec::new();
    let mut path = "/places?q=Page&limit=1".to_string();
    loop {
        let (status, page) = request(&state, &token, "GET", &path).await;
        assert_eq!(status, StatusCode::OK);
        found.extend(
            page["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap().to_owned()),
        );
        match page["meta"]["nextCursor"].as_str() {
            Some(cursor) => path = format!("/places?q=Page&limit=1&cursor={cursor}"),
            None => break,
        }
    }
    assert_eq!(found.len(), 3);
    found.sort();
    found.dedup();
    assert_eq!(found.len(), 3);
    for id in &ids {
        assert!(found.contains(&id.to_string()));
    }
    sqlx::query("create function reject_admin_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$").execute(&db).await.unwrap();
    sqlx::query("create trigger reject_admin_audit before insert on audit_log for each row execute function reject_admin_audit()").execute(&db).await.unwrap();
    let result = request(&state, &token, "POST", &format!("/places/{}/hide", ids[0])).await;
    assert_eq!(result.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!result.1.to_string().contains("audit unavailable"));
    let hidden: bool =
        sqlx::query_scalar("select admin_hidden_at is not null from places where id=$1")
            .bind(ids[0])
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(!hidden);
    let failed: Uuid = sqlx::query_scalar("insert into jobs(kind,payload,status,attempts) values('rollback','{}','failed',2) returning id").fetch_one(&db).await.unwrap();
    let queued: Uuid = sqlx::query_scalar("insert into jobs(kind,payload,status,attempts) values('rollback','{}','queued',2) returning id").fetch_one(&db).await.unwrap();
    sqlx::query("update places set admin_hidden_at=now() where id=$1")
        .bind(ids[1])
        .execute(&db)
        .await
        .unwrap();
    for path in [
        format!("/places/{}/unhide", ids[1]),
        format!("/jobs/{failed}/retry"),
        format!("/jobs/{queued}/cancel"),
    ] {
        assert_eq!(
            request(&state, &token, "POST", &path).await.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{path}"
        );
    }
    let still_hidden: bool =
        sqlx::query_scalar("select admin_hidden_at is not null from places where id=$1")
            .bind(ids[1])
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(still_hidden);
    for (id, expected) in [(failed, "failed"), (queued, "queued")] {
        let row: (String, i32) = sqlx::query_as("select status,attempts from jobs where id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(row, (expected.to_string(), 2));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn system_does_not_expose_database_canaries(db: sqlx::PgPool) {
    let (_, token, _) = user(&db, "admin", "system-canary@example.test").await;
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    sqlx::query("update users set password_hash='system_secret_canary_password' where email='system-canary@example.test'").execute(&db).await.unwrap();
    sqlx::query("insert into jobs(kind,payload,last_error) values('canary','{\"token\":\"system_secret_canary_token\"}','system_secret_canary_error')").execute(&db).await.unwrap();
    let (status, body) = request(&state, &token, "GET", "/system").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["database"], "healthy");
    assert!(!body.to_string().contains("system_secret_canary"));
    assert!(!body.to_string().contains(&token));
}
