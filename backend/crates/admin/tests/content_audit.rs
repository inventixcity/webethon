#![allow(clippy::unwrap_used)]
//! Audit log read routes: role gate, filters and paging, CSV export, and secret redaction.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{AppState, config::Config, email::LogSender};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

const CSV_HEADER: &str = "id,at,actorId,action,targetType,targetId,ip,userAgent,requestId,meta\r\n";

struct Fixture {
    state: AppState,
    admin_id: Uuid,
    admin_token: String,
    user_token: String,
}

async fn session(db: &sqlx::PgPool, user: Uuid) -> String {
    let (token, hash) = kernel::crypto::new_token();
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    )
    .bind(user)
    .bind(hash.as_slice())
    .execute(db)
    .await
    .unwrap();
    token
}

async fn fixture(db: sqlx::PgPool) -> Fixture {
    let admin_id: Uuid = sqlx::query_scalar(
        "insert into users(email,role,email_verified_at) values('audit-admin@example.test','admin',now()) returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "insert into users(email) values('audit-user@example.test') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let admin_token = session(&db, admin_id).await;
    let user_token = session(&db, user_id).await;
    let state = AppState {
        db,
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    Fixture {
        state,
        admin_id,
        admin_token,
        user_token,
    }
}

struct Reply {
    status: StatusCode,
    content_type: String,
    body: String,
}

async fn get(state: &AppState, token: Option<&str>, uri: &str) -> Reply {
    let mut request = Request::builder().method("GET").uri(uri);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = admin::router()
        .with_state(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = to_bytes(response.into_body(), 5_000_000).await.unwrap();
    Reply {
        status,
        content_type,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

async fn get_json(state: &AppState, token: &str, uri: &str) -> (StatusCode, Value) {
    let reply = get(state, Some(token), uri).await;
    (
        reply.status,
        serde_json::from_str(&reply.body).unwrap_or(Value::Null),
    )
}

async fn insert_audit(
    db: &sqlx::PgPool,
    at: &str,
    actor: Option<Uuid>,
    action: &str,
    target_id: &str,
    meta: Value,
) -> i64 {
    sqlx::query_scalar(
        "insert into audit_log(at,actor_id,action,target_type,target_id,ip,user_agent,request_id,meta) values($1::timestamptz,$2,$3,'user',$4,'203.0.113.7','test-agent','req-1',$5) returning id",
    )
    .bind(at)
    .bind(actor)
    .bind(action)
    .bind(target_id)
    .bind(meta)
    .fetch_one(db)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_routes_reject_non_admins(db: sqlx::PgPool) {
    let fixture = fixture(db).await;
    for uri in ["/audit", "/audit/export"] {
        let as_user = get(&fixture.state, Some(&fixture.user_token), uri).await;
        assert_eq!(as_user.status, StatusCode::FORBIDDEN, "{uri}");
        let anonymous = get(&fixture.state, None, uri).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_list_filters_paging_and_limits(db: sqlx::PgPool) {
    let fixture = fixture(db.clone()).await;
    let admin = fixture.admin_id;
    let other = Uuid::new_v4();
    let a = insert_audit(
        &db,
        "2026-11-01T00:00:00Z",
        Some(admin),
        "admin.user.suspend",
        "t-a",
        json!({"role":"user"}),
    )
    .await;
    let b = insert_audit(
        &db,
        "2026-11-02T00:00:00Z",
        Some(admin),
        "admin.user.restore",
        "t-b",
        json!({}),
    )
    .await;
    let c = insert_audit(
        &db,
        "2026-11-03T00:00:00Z",
        Some(other),
        "admin.user.suspend",
        "t-c",
        json!({}),
    )
    .await;
    let d = insert_audit(
        &db,
        "2026-11-04T00:00:00Z",
        Some(other),
        "auth.sign_in",
        "t-d",
        json!({}),
    )
    .await;
    let e = insert_audit(
        &db,
        "2026-11-05T00:00:00Z",
        Some(admin),
        "admin.user.role",
        "t-e",
        json!({}),
    )
    .await;
    let token = fixture.admin_token.as_str();
    let state = &fixture.state;

    // Newest first, with no duplicates across pages.
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let uri = match &cursor {
            Some(c) => format!("/audit?limit=2&cursor={c}"),
            None => "/audit?limit=2".to_owned(),
        };
        let (status, body) = get_json(state, token, &uri).await;
        assert_eq!(status, StatusCode::OK);
        let rows = body["data"].as_array().unwrap();
        assert!(rows.len() <= 2);
        seen.extend(rows.iter().map(|row| row["id"].as_i64().unwrap()));
        pages += 1;
        match body["meta"]["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
        assert!(pages < 10, "paging did not end");
    }
    assert_eq!(seen, vec![e, d, c, b, a]);
    assert_eq!(pages, 3);

    // Each filter narrows the list, and they combine.
    let ids = |body: &Value| -> Vec<i64> {
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect()
    };
    let admin_q = format!("/audit?actor={admin}");
    let (_, body) = get_json(state, token, &admin_q).await;
    assert_eq!(ids(&body), vec![e, b, a]);
    let (_, body) = get_json(state, token, "/audit?action=admin.user.suspend").await;
    assert_eq!(ids(&body), vec![c, a]);
    let (_, body) = get_json(state, token, "/audit?target=t-d").await;
    assert_eq!(ids(&body), vec![d]);
    let (_, body) = get_json(
        state,
        token,
        "/audit?from=2026-11-02T00:00:00Z&to=2026-11-04T00:00:00Z",
    )
    .await;
    assert_eq!(ids(&body), vec![d, c, b]);
    let combined = format!("/audit?action=admin.user.suspend&actor={other}");
    let (_, body) = get_json(state, token, &combined).await;
    assert_eq!(ids(&body), vec![c]);
    // A value that looks like SQL is only a literal string.
    let (status, body) = get_json(state, token, "/audit?action=%27%20or%201%3D1--").await;
    assert_eq!(status, StatusCode::OK);
    assert!(ids(&body).is_empty());

    // Limit bounds: 1 and 100 are accepted, 0 and 101 are refused.
    for (uri, expected) in [
        ("/audit?limit=1", StatusCode::OK),
        ("/audit?limit=100", StatusCode::OK),
        ("/audit?limit=0", StatusCode::BAD_REQUEST),
        ("/audit?limit=101", StatusCode::BAD_REQUEST),
        ("/audit?limit=abc", StatusCode::BAD_REQUEST),
        ("/audit?unknown=1", StatusCode::BAD_REQUEST),
        ("/audit?actor=not-a-uuid", StatusCode::BAD_REQUEST),
        ("/audit?from=yesterday", StatusCode::BAD_REQUEST),
        ("/audit?cursor=%21%21%21", StatusCode::BAD_REQUEST),
    ] {
        let (status, body) = get_json(state, token, uri).await;
        assert_eq!(status, expected, "{uri}");
        if expected == StatusCode::BAD_REQUEST {
            assert_eq!(body["error"]["code"], "VALIDATION_FAILED", "{uri}");
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_export_is_csv_escaped_and_audited(db: sqlx::PgPool) {
    let fixture = fixture(db.clone()).await;
    let admin = fixture.admin_id;
    insert_audit(
        &db,
        "2026-11-10T08:00:00Z",
        Some(admin),
        "admin.user.suspend",
        "=HYPERLINK(\"http://evil.example\",\"click\")",
        json!({"role":"user"}),
    )
    .await;
    let token = fixture.admin_token.as_str();
    let state = &fixture.state;

    let reply = get(state, Some(token), "/audit/export").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(
        reply.content_type.starts_with("text/csv"),
        "{}",
        reply.content_type
    );
    assert!(reply.body.starts_with(CSV_HEADER), "{}", reply.body);
    // The stored value starts with `=`, so it gets a `'` and the CSV quoting wraps it.
    assert!(
        reply
            .body
            .contains("\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"click\"\")\""),
        "{}",
        reply.body
    );
    assert!(!reply.body.lines().any(|line| line.starts_with('=')));
    // The export's own audit row is written after the snapshot, so it must not be in the file.
    assert!(!reply.body.contains("admin.audit.export"), "{}", reply.body);

    // The export is audited, with filters and a row count, but without the rows.
    let meta: Value = sqlx::query_scalar(
        "select meta from audit_log where action='admin.audit.export' order by id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(meta["after"]["rows"], 1);
    assert!(!meta.to_string().contains("HYPERLINK"));
    assert!(!meta.to_string().contains("evil.example"));

    // A filter with no matches still gives a header-only file.
    let empty = get(state, Some(token), "/audit/export?action=no.such.action").await;
    assert_eq!(empty.status, StatusCode::OK);
    assert_eq!(empty.body, CSV_HEADER);

    // Bad filters are refused before anything is exported or audited.
    let bad = get(state, Some(token), "/audit/export?actor=nope").await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let exports: i64 =
        sqlx::query_scalar("select count(*) from audit_log where action='admin.audit.export'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(exports, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_responses_never_expose_secrets(db: sqlx::PgPool) {
    let fixture = fixture(db.clone()).await;
    insert_audit(
        &db,
        "2026-11-12T09:30:00Z",
        Some(fixture.admin_id),
        "admin.user.mfa_reset",
        "t-secret",
        json!({
            "passwordHash": "pw-hash-SECRET-1",
            "token": "tok-SECRET-2",
            "before": {"code": "654321", "role": "user"},
            "note": "kept"
        }),
    )
    .await;
    let token = fixture.admin_token.as_str();
    let state = &fixture.state;
    for uri in ["/audit", "/audit/export"] {
        let reply = get(state, Some(token), uri).await;
        assert_eq!(reply.status, StatusCode::OK, "{uri}");
        assert!(!reply.body.contains("SECRET-1"), "{uri}: {}", reply.body);
        assert!(!reply.body.contains("SECRET-2"), "{uri}: {}", reply.body);
        assert!(!reply.body.contains("654321"), "{uri}: {}", reply.body);
        assert!(
            !reply.body.contains("passwordHash"),
            "{uri}: {}",
            reply.body
        );
        // Non-secret facts still come through.
        assert!(reply.body.contains("kept"), "{uri}: {}", reply.body);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_export_streams_every_page_once(db: sqlx::PgPool) {
    let fixture = fixture(db.clone()).await;
    // 1,201 rows span three database pages (500, 500, 201), so the stream has to continue past
    // the first page without losing or repeating rows.
    sqlx::query(
        "insert into audit_log(at,actor_id,action,target_type,target_id,meta) \
         select timestamptz '2026-01-01' + g * interval '1 second', $1, 'bulk.seed', 'user', 'row-' || g, '{}' \
         from generate_series(1, 1201) g",
    )
    .bind(fixture.admin_id)
    .execute(&db)
    .await
    .unwrap();
    let reply = get(
        &fixture.state,
        Some(&fixture.admin_token),
        "/audit/export?action=bulk.seed",
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let mut lines = reply.body.lines();
    assert_eq!(format!("{}\r\n", lines.next().unwrap()), CSV_HEADER);
    let ids: Vec<i64> = lines
        .map(|line| line.split(',').next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 1201);
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 1201);
    // Newest first, like the list.
    assert!(ids.windows(2).all(|pair| pair[0] > pair[1]));
}
