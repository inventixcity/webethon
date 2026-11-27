use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{AppState, config::Config, email::LogSender, request::RequestMeta, session};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn bulk_create_policy_validation_and_quota(db: PgPool) {
    use kernel::viewer::{Role, Viewer};
    let config = Config::from_env().unwrap();
    let (id, _) = user(&db, &config).await;
    let viewer = Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let mut definitions: Value =
        serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
            .unwrap();
    definitions["notes"]["maxPerOwner"] = json!(3);
    let reg = crate::EntityRegistry::from_json(&definitions.to_string()).unwrap();
    let mut restricted = definitions.clone();
    restricted["notes"]["create"] = json!("admin");
    let restricted = crate::EntityRegistry::from_json(&restricted.to_string()).unwrap();
    assert!(
        crate::api::prepare_create_data(&restricted, &viewer, "notes", json!({"title":"x"}))
            .is_err()
    );
    let mut denied_tx = db.begin().await.unwrap();
    assert!(
        crate::api::create_many_in_tx(
            &mut denied_tx,
            &restricted,
            &viewer,
            &meta,
            "notes",
            vec![json!({"title":"x"})],
            None
        )
        .await
        .is_err()
    );
    denied_tx.rollback().await.unwrap();
    let prepared =
        crate::api::prepare_create_data(&reg, &viewer, "notes", json!({"title":"  hello  "}))
            .unwrap();
    assert_eq!(prepared["title"], "hello");
    assert_eq!(prepared["body"], "");
    assert!(crate::api::prepare_create_data(&reg, &viewer, "unknown", json!({})).is_err());
    assert_eq!(
        crate::api::personal_capacity(&db, &reg, &viewer, "notes")
            .await
            .unwrap(),
        Some(3)
    );
    let mut tx = db.begin().await.unwrap();
    assert!(
        crate::api::create_many_in_tx(
            &mut tx,
            &reg,
            &viewer,
            &meta,
            "notes",
            vec![json!({"title":"valid"}), json!({})],
            None
        )
        .await
        .is_err()
    );
    let count: i64 = sqlx::query_scalar("select count(*) from records")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let batch = crate::api::create_many_in_tx(
        &mut tx,
        &reg,
        &viewer,
        &meta,
        "notes",
        vec![json!({"title":"  hello  "}), json!({"title":"second"})],
        None,
    )
    .await
    .unwrap();
    assert_eq!(batch[0]["data"], prepared);
    let ordinary = crate::api::create_in_tx(
        &mut tx,
        &reg,
        &viewer,
        &meta,
        "notes",
        json!({"title":"  hello  "}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(ordinary["data"], prepared);
    tx.commit().await.unwrap();
    assert_eq!(
        crate::api::personal_capacity(&db, &reg, &viewer, "notes")
            .await
            .unwrap(),
        Some(0)
    );
    let audits: i64 =
        sqlx::query_scalar("select count(*) from audit_log where action='record.create'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(audits, 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn bulk_quota_race_and_audit_failure(db: PgPool) {
    use kernel::viewer::{Role, Viewer};
    let config = Config::from_env().unwrap();
    let (id, _) = user(&db, &config).await;
    let viewer = Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let mut definitions: Value =
        serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
            .unwrap();
    definitions["notes"]["maxPerOwner"] = json!(3);
    let reg = crate::EntityRegistry::from_json(&definitions.to_string()).unwrap();
    let run = || async {
        let mut tx = db.begin().await.unwrap();
        let result = crate::api::create_many_in_tx(
            &mut tx,
            &reg,
            &viewer,
            &meta,
            "notes",
            vec![json!({"title":"one"}), json!({"title":"two"})],
            None,
        )
        .await;
        if result.is_ok() {
            tx.commit().await.unwrap();
        } else {
            tx.rollback().await.unwrap();
        }
        result.is_ok()
    };
    let (a, b) = tokio::join!(run(), run());
    assert_ne!(a, b);
    sqlx::query("create function reject_record_audit() returns trigger language plpgsql as $$ begin raise exception 'audit failed'; end $$").execute(&db).await.unwrap();
    sqlx::query("create trigger reject_record_audit before insert on audit_log for each row execute function reject_record_audit()").execute(&db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert!(
        crate::api::create_many_in_tx(
            &mut tx,
            &reg,
            &viewer,
            &meta,
            "notes",
            vec![json!({"title":"third"})],
            None
        )
        .await
        .is_err()
    );
    let _ = tx.commit().await;
    let count: i64 = sqlx::query_scalar("select count(*) from records")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn account_security(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (_, token) = user(&db, &config).await;
    let (status, me) = call(&app, "GET", "/me", Some(&token), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(me["data"].get("passwordHash").is_none());
    assert!(me["data"].get("status").is_none());
    for field in ["role", "email", "status"] {
        assert_eq!(
            call(
                &app,
                "PATCH",
                "/me",
                Some(&token),
                Some(json!({field:"admin"})),
                &[]
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/me",
            Some(&token),
            Some(json!({"avatarUrl":"http://example.com"})),
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Self-deletion needs the current password (A1-18): without it the request is refused and the account stays.
    let (_, other) = user(&db, &config).await;
    assert!(
        call(&app, "DELETE", "/me", Some(&other), None, &[])
            .await
            .0
            .is_client_error()
    );
    assert_eq!(
        call(&app, "GET", "/me", Some(&other), None, &[]).await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn demo_account_cannot_change_profile_or_delete_but_can_create_records(db: PgPool) {
    let mut config = Config::from_env().unwrap();
    config.demo_email = Some("demo@example.com".into());
    let config = Arc::new(config);
    let id: Uuid =
        sqlx::query_scalar("insert into users(email) values('demo@example.com') returning id")
            .fetch_one(&db)
            .await
            .unwrap();
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let (token, _) = session::create(&db, &config, id, &meta).await.unwrap();
    let state = AppState {
        db: db.clone(),
        config,
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let source = std::fs::read_to_string("../../config/entities.json").unwrap();
    let registry = Arc::new(crate::registry::parse_registry(&source).unwrap());
    let app = crate::router(registry).with_state(state);
    let (status, body) = call(
        &app,
        "PATCH",
        "/me",
        Some(&token),
        Some(json!({"displayName":"changed"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["error"]["message"],
        "The demo account cannot be changed."
    );
    assert_eq!(
        call(&app, "DELETE", "/me", Some(&token), None, &[]).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", "/me", Some(&token), None, &[]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&token),
            Some(json!({"data":{"title":"demo"}})),
            &[]
        )
        .await
        .0,
        StatusCode::CREATED
    );
}

fn app(db: PgPool, max: u64) -> (Router, Arc<Config>) {
    let config = Arc::new(Config::from_env().unwrap());
    let state = AppState {
        db,
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let source = std::fs::read_to_string("../../config/entities.json").unwrap();
    let mut source: Value = serde_json::from_str(&source).unwrap();
    source["notes"]["maxPerOwner"] = json!(max);
    let registry = Arc::new(crate::registry::parse_registry(&source.to_string()).unwrap());
    (crate::router(registry).with_state(state), config)
}
async fn user(db: &PgPool, config: &Config) -> (Uuid, String) {
    let id: Uuid = sqlx::query_scalar("insert into users(email) values($1) returning id")
        .bind(format!("{}@example.com", Uuid::new_v4()))
        .fetch_one(db)
        .await
        .unwrap();
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let (token, _) = session::create(db, config, id, &meta).await.unwrap();
    (id, token)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        request = request.header("authorization", format!("Bearer {t}"));
    }
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    let content = if let Some(b) = body {
        request = request.header("content-type", "application/json");
        b.to_string()
    } else {
        String::new()
    };
    let response = app
        .clone()
        .oneshot(request.body(Body::from(content)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}
#[sqlx::test(migrations = "../../migrations")]
async fn crud_security_and_idempotency(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (_, a) = user(&db, &config).await;
    let (_, b) = user(&db, &config).await;
    let body = json!({"data":{"title":"hello"}});
    let (s, created) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&a),
        Some(body.clone()),
        &[("idempotency-key", "abcdefgh")],
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let id = created["data"]["id"].as_str().unwrap();
    let path = format!("/entities/notes/{id}");
    assert_eq!(created["data"]["data"]["pinned"], false);
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&a),
            Some(body),
            &[("idempotency-key", "abcdefgh")]
        )
        .await
        .1,
        created
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&a),
            Some(json!({"data":{"title":"different"}})),
            &[("idempotency-key", "abcdefgh")]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for method in ["GET", "PATCH", "DELETE"] {
        assert_eq!(
            call(
                &app,
                method,
                &path,
                Some(&b),
                if method == "PATCH" {
                    Some(json!({"data":{"title":"x"}}))
                } else {
                    None
                },
                &[("if-match", "1")]
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&a),
            Some(json!({"data":{"title":"changed"}})),
            &[]
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&a),
            Some(json!({"data":{"title":"changed"},"visibility":"public"})),
            &[("if-match", "\"1\"")]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&b), None, &[]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&a),
            Some(json!({"data":{"title":"x"}})),
            &[("if-match", "1")]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "DELETE", &path, Some(&a), None, &[("if-match", "2")])
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&a), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &path, Some(&a), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    let (s, v) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&a),
        Some(json!({"data":{"title":"x".repeat(201)}})),
        &[],
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "VALIDATION_FAILED");
    assert!(v["error"]["details"].is_array());
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&a),
            Some(json!({"data":{"title":"x"},"unexpected":1})),
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn pagination_search_and_query_validation(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (_, a) = user(&db, &config).await;
    for title in ["same", "same", "same", "100%_real", "100xxreal"] {
        assert_eq!(
            call(
                &app,
                "POST",
                "/entities/notes",
                Some(&a),
                Some(json!({"data":{"title":title}})),
                &[]
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    for q in [
        "limit=101",
        "sort=title%3Bdrop",
        "filter%5Btitle%3Bdrop%5D=x",
        "junk=1",
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/entities/notes?{q}"),
                Some(&a),
                None,
                &[]
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (s, result) = call(&app, "GET", "/entities/notes?q=%25_", Some(&a), None, &[]).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(result["data"].as_array().unwrap().len(), 1);
    let mut ids = std::collections::HashSet::new();
    let mut path = "/entities/notes?sort=title&limit=2".to_string();
    loop {
        let (s, v) = call(&app, "GET", &path, Some(&a), None, &[]).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        for item in v["data"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
        if let Some(c) = v["meta"]["nextCursor"].as_str() {
            path = format!("/entities/notes?sort=title&limit=2&cursor={c}");
        } else {
            break;
        }
    }
    assert_eq!(ids.len(), 5);
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_limit(db: PgPool) {
    let (app, config) = app(db.clone(), 4);
    let (_, a) = user(&db, &config).await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let app = app.clone();
        let token = a.clone();
        tasks.spawn(async move {
            call(
                &app,
                "POST",
                "/entities/notes",
                Some(&token),
                Some(json!({"data":{"title":"x"}})),
                &[],
            )
            .await
            .0
        });
    }
    let mut success = 0;
    while let Some(result) = tasks.join_next().await {
        if result.unwrap() == StatusCode::CREATED {
            success += 1;
        }
    }
    assert_eq!(success, 4);
    let count: i64 = sqlx::query_scalar("select count(*) from records where deleted_at is null")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 4);
}

#[sqlx::test(migrations = "../../migrations")]
async fn numeric_and_nullable_pagination_and_deleted_owner(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner, token) = user(&db, &config).await;
    for priority in [3, 1, 2] {
        assert_eq!(
            call(
                &app,
                "POST",
                "/entities/tasks",
                Some(&token),
                Some(json!({"data":{"title":"task", "priority":priority}})),
                &[]
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let mut path = "/entities/tasks?sort=priority&limit=1".to_string();
    let mut priorities = Vec::new();
    loop {
        let (status, response) = call(&app, "GET", &path, Some(&token), None, &[]).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        priorities.push(response["data"][0]["data"]["priority"].as_i64().unwrap());
        if let Some(cursor) = response["meta"]["nextCursor"].as_str() {
            path = format!("/entities/tasks?sort=priority&limit=1&cursor={cursor}");
        } else {
            break;
        }
    }
    assert_eq!(priorities, vec![1, 2, 3]);
    let (status, first) = call(
        &app,
        "GET",
        "/entities/tasks?sort=due&limit=1",
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cursor = first["meta"]["nextCursor"].as_str().unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/tasks?sort=due&limit=1&cursor={cursor}"),
            Some(&token),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, public) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&token),
        Some(json!({"data":{"title":"public"},"visibility":"public"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let record_path = format!("/entities/notes/{}", public["data"]["id"].as_str().unwrap());
    assert_eq!(
        call(&app, "GET", &record_path, None, None, &[]).await.0,
        StatusCode::OK
    );
    sqlx::query("update users set deleted_at=now() where id=$1")
        .bind(owner)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "GET", &record_path, None, None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, response) =
        call(&app, "GET", "/entities/notes?scope=public", None, None, &[]).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["data"].as_array().unwrap().len(), 0);
}

#[test]
fn social_settings_are_strict_and_compatible() {
    let source = std::fs::read_to_string("../../config/entities.json").unwrap();
    let mut config: Value = serde_json::from_str(&source).unwrap();
    let registry = crate::EntityRegistry::from_json(&source).unwrap();
    assert!(registry.definition("tasks").unwrap().social.is_none());
    assert!(
        registry
            .definition("notes")
            .unwrap()
            .social
            .as_ref()
            .unwrap()
            .comments
    );
    for invalid in [
        json!({"unknown": true}),
        json!({"reactions":["like","like"]}),
        json!({"reactions":["Like"]}),
        json!({"reactions":["a".repeat(33)]}),
        json!({"reactions":(0..17).map(|i| format!("r{i}")).collect::<Vec<_>>()}),
    ] {
        config["notes"]["social"] = invalid;
        assert!(crate::EntityRegistry::from_json(&config.to_string()).is_err());
    }
    config["notes"]["social"] = json!({});
    let registry = crate::EntityRegistry::from_json(&config.to_string()).unwrap();
    let social = registry
        .definition("notes")
        .unwrap()
        .social
        .as_ref()
        .unwrap();
    assert!(!social.comments && !social.bookmarks && social.reactions.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn facade_access_validation_versions_and_caps(db: PgPool) {
    use kernel::{
        ErrorCode,
        viewer::{Role, Viewer},
    };
    let config = Arc::new(Config::from_env().unwrap());
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let (id, _) = user(&db, &config).await;
    let (other_id, _) = user(&db, &config).await;
    let viewer = |id| Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };
    let owner = viewer(id);
    let other = viewer(other_id);
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let mut config: Value =
        serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
            .unwrap();
    config["notes"]["maxPerOwner"] = json!(1);
    let reg = crate::EntityRegistry::from_json(&config.to_string()).unwrap();
    assert_eq!(
        crate::api::create(&state, &reg, &owner, &meta, "notes", json!({}), None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ValidationFailed
    );
    let record = crate::api::create(
        &state,
        &reg,
        &owner,
        &meta,
        "notes",
        json!({"title":"hello"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(record["data"]["body"], "");
    let record_id = Uuid::parse_str(record["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        crate::api::read(&state, &reg, Some(&other), "notes", record_id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        crate::api::update(
            &state,
            &reg,
            &other,
            &meta,
            "notes",
            record_id,
            json!({"title":"x"}),
            1
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        crate::api::create(
            &state,
            &reg,
            &owner,
            &meta,
            "notes",
            json!({"title":"second"}),
            None
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::LimitReached
    );
    assert_eq!(
        crate::api::update(
            &state,
            &reg,
            &owner,
            &meta,
            "notes",
            record_id,
            json!({"title":5}),
            1
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ValidationFailed
    );
    let updated = crate::api::update(
        &state,
        &reg,
        &owner,
        &meta,
        "notes",
        record_id,
        json!({"title":"new"}),
        1,
    )
    .await
    .unwrap();
    assert_eq!(updated["version"], 2);
    assert_eq!(
        crate::api::update(
            &state,
            &reg,
            &owner,
            &meta,
            "notes",
            record_id,
            json!({"title":"stale"}),
            1
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::VersionConflict
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn transactional_facade_commit_rollback_and_security(db: PgPool) {
    use kernel::{
        ErrorCode,
        viewer::{Role, Viewer},
    };
    let config = Config::from_env().unwrap();
    let (id, _) = user(&db, &config).await;
    let (other_id, _) = user(&db, &config).await;
    let viewer = |id| Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };
    let owner = viewer(id);
    let other = viewer(other_id);
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let mut definitions: Value =
        serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
            .unwrap();
    definitions["notes"]["maxPerOwner"] = json!(1);
    let reg = crate::EntityRegistry::from_json(&definitions.to_string()).unwrap();
    let mut tx = db.begin().await.unwrap();
    let record = crate::api::create_in_tx(
        &mut tx,
        &reg,
        &owner,
        &meta,
        "notes",
        json!({"title":"first"}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(record["data"]["body"], "");
    assert_eq!(
        crate::api::create_in_tx(
            &mut tx,
            &reg,
            &owner,
            &meta,
            "notes",
            json!({"title":"second"}),
            None
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::LimitReached
    );
    tx.rollback().await.unwrap();
    let count: i64 =
        sqlx::query_scalar("select count(*) from audit_log where action='record.create'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let mut tx = db.begin().await.unwrap();
    let record = crate::api::create_in_tx(
        &mut tx,
        &reg,
        &owner,
        &meta,
        "notes",
        json!({"title":"committed"}),
        None,
    )
    .await
    .unwrap();
    let record_id = Uuid::parse_str(record["id"].as_str().unwrap()).unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::api::update_in_tx(
            &mut tx,
            &reg,
            &other,
            &meta,
            "notes",
            record_id,
            json!({"title":"stolen"}),
            1
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
    let updated = crate::api::update_in_tx(
        &mut tx,
        &reg,
        &owner,
        &meta,
        "notes",
        record_id,
        json!({"title":"changed"}),
        1,
    )
    .await
    .unwrap();
    assert_eq!(updated["version"], 2);
    assert_eq!(
        crate::api::update_in_tx(
            &mut tx,
            &reg,
            &owner,
            &meta,
            "notes",
            record_id,
            json!({"title":"stale"}),
            1
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::VersionConflict
    );
    tx.rollback().await.unwrap();
    let (version, title): (i32, String) =
        sqlx::query_as("select version,data->>'title' from records where id=$1")
            .bind(record_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((version, title.as_str()), (1, "committed"));
    let count: i64 =
        sqlx::query_scalar("select count(*) from audit_log where action='record.update'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let mut tx = db.begin().await.unwrap();
    crate::api::update_in_tx(
        &mut tx,
        &reg,
        &owner,
        &meta,
        "notes",
        record_id,
        json!({"title":"final"}),
        1,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action in ('record.create','record.update')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn full_text_search_ranking_scope_and_pagination(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner, token) = user(&db, &config).await;
    let (other, _) = user(&db, &config).await;
    let mut ids = Vec::new();
    for (who, title, body, visibility) in [
        (owner, "running running running", "", "private"),
        (owner, "running", "", "public"),
        (owner, "running", "", "private"),
        (other, "running", "", "private"),
        (owner, "secret", "", "private"),
    ] {
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values ('notes',$1,$2,$3) returning id")
            .bind(who).bind(json!({"title":title,"body":body,"tags":["running"]})).bind(visibility)
            .fetch_one(&db).await.unwrap();
        ids.push(id);
    }
    let mut path = "/entities/notes?q=run&limit=1&sort=createdAt".to_owned();
    let mut found = Vec::new();
    let mut first_cursor = String::new();
    loop {
        let (status, result) = call(&app, "GET", &path, Some(&token), None, &[]).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        found.push(result["data"][0]["id"].as_str().unwrap().to_owned());
        if let Some(cursor) = result["meta"]["nextCursor"].as_str() {
            if first_cursor.is_empty() {
                first_cursor = cursor.to_owned();
            }
            path = format!("/entities/notes?q=run&limit=1&sort=createdAt&cursor={cursor}");
        } else {
            break;
        }
    }
    assert_eq!(found.len(), 3);
    assert_eq!(found[0], ids[0].to_string());
    assert_eq!(
        found.iter().collect::<std::collections::HashSet<_>>().len(),
        3
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/notes?q=secret&cursor={first_cursor}"),
            Some(&token),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, public) = call(
        &app,
        "GET",
        "/entities/notes?q=run&scope=public",
        None,
        None,
        &[],
    )
    .await;
    assert_eq!(public["data"].as_array().unwrap().len(), 1);
    let (_, phrase) = call(
        &app,
        "GET",
        "/entities/notes?q=%22running%20running%22",
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(phrase["data"].as_array().unwrap().len(), 1);
    let (_, excluded) = call(
        &app,
        "GET",
        "/entities/notes?q=running%20-secret",
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(excluded["data"].as_array().unwrap().len(), 3);
    let (status, _) = call(
        &app,
        "GET",
        "/entities/notes?q=%25%25%25",
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("update records set data = '{\"title\":\"changed\"}' where id=$1")
        .bind(ids[0])
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("update records set deleted_at=now() where id=$1")
        .bind(ids[1])
        .execute(&db)
        .await
        .unwrap();
    let (_, after) = call(
        &app,
        "GET",
        "/entities/notes?q=run",
        Some(&token),
        None,
        &[],
    )
    .await;
    assert_eq!(after["data"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_records_roles_and_scopes(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, owner) = user(&db, &config).await;
    let (member_id, member) = user(&db, &config).await;
    let (viewer_id, viewer) = user(&db, &config).await;
    let (admin_id, admin) = user(&db, &config).await;
    let (outsider_id, outsider) = user(&db, &config).await;
    sqlx::query("update users set role='admin' where id=$1")
        .bind(outsider_id)
        .execute(&db)
        .await
        .unwrap();
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Team',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner_id)
    .fetch_one(&db)
    .await
    .unwrap();
    for (id, role) in [
        (owner_id, "owner"),
        (member_id, "member"),
        (viewer_id, "viewer"),
        (admin_id, "admin"),
    ] {
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,$3)")
            .bind(team)
            .bind(id)
            .bind(role)
            .execute(&db)
            .await
            .unwrap();
    }
    let body = json!({"data":{"title":"Team"},"teamId":team});
    let (status, created) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&member),
        Some(body.clone()),
        &[("idempotency-key", "team-key")],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["data"]["teamId"], team.to_string());
    let before_public: i64 = sqlx::query_scalar("select count(*) from records")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&member),
            Some(json!({"data":{"title":"No"},"teamId":team,"visibility":"public"})),
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let after_public: i64 = sqlx::query_scalar("select count(*) from records")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(before_public, after_public);
    let path = format!(
        "/entities/notes/{}",
        created["data"]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&outsider), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&viewer), None, &[]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&viewer),
            Some(json!({"data":{"title":"No"}})),
            &[("if-match", "1")]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"data":{"title":"Yes"}})),
            &[("if-match", "1")]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&admin),
            Some(json!({"visibility":"public"})),
            &[("if-match", "2")]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&viewer),
            Some(body.clone()),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, mine) = call(
        &app,
        "GET",
        "/entities/notes?scope=mine",
        Some(&member),
        None,
        &[],
    )
    .await;
    assert!(mine["data"].as_array().unwrap().is_empty());
    let (_, listed) = call(
        &app,
        "GET",
        &format!("/entities/notes?scope=team&teamId={team}"),
        Some(&viewer),
        None,
        &[],
    )
    .await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/notes?scope=mine&teamId={team}"),
            Some(&member),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let other_team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Other',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner_id)
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member')")
        .bind(other_team)
        .bind(member_id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/notes?scope=team&teamId={other_team}"),
            Some(&viewer),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (mismatch_status, mismatch) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&member),
        Some(json!({"data":{"title":"Team"},"teamId":other_team})),
        &[("idempotency-key", "team-key")],
    )
    .await;
    assert_eq!(mismatch_status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(mismatch["error"]["code"], "IDEMPOTENCY_MISMATCH");
    assert!(mismatch.get("data").is_none());
    assert!(
        !mismatch
            .to_string()
            .contains(created["data"]["id"].as_str().unwrap())
    );
    assert_eq!(
        call(&app, "DELETE", &path, Some(&admin), None, &[]).await.0,
        StatusCode::NO_CONTENT
    );
    sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
        .bind(team)
        .bind(member_id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "GET", &path, Some(&member), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&member),
            Some(body),
            &[("idempotency-key", "team-key")]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn workspace_caps_and_cursor_bindings(db: PgPool) {
    let (app, config) = app(db.clone(), 1);
    let (id, token) = user(&db, &config).await;
    let (other_id, other) = user(&db, &config).await;
    let mut teams = Vec::new();
    for _ in 0..2 {
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Team',$1,$2) returning id",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
        for member in [id, other_id] {
            sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member')")
                .bind(team)
                .bind(member)
                .execute(&db)
                .await
                .unwrap();
        }
        teams.push(team);
    }
    for target in [None, Some(teams[0]), Some(teams[1])] {
        let mut body = json!({"data":{"title":"one"}});
        if let Some(team) = target {
            body["teamId"] = json!(team);
        }
        assert_eq!(
            call(
                &app,
                "POST",
                "/entities/notes",
                Some(&token),
                Some(body.clone()),
                &[]
            )
            .await
            .0,
            StatusCode::CREATED
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/entities/notes",
                Some(&token),
                Some(body),
                &[]
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
        .bind(teams[0])
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let personal = call(
        &app,
        "GET",
        "/entities/notes?scope=mine",
        Some(&token),
        None,
        &[],
    )
    .await
    .1;
    assert_eq!(personal["data"].as_array().unwrap().len(), 1);
    let personal_path = format!(
        "/entities/notes/{}",
        personal["data"][0]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "DELETE", &personal_path, Some(&token), None, &[])
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&token),
            Some(json!({"data":{"title":"new"}})),
            &[]
        )
        .await
        .0,
        StatusCode::CREATED
    );
    sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member')")
        .bind(teams[0])
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    // A second owner's record provides a next cursor without changing the first owner's cap.
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&other),
            Some(json!({"data":{"title":"two"},"teamId":teams[1]})),
            &[]
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let path = format!("/entities/notes?scope=team&teamId={}&limit=1", teams[1]);
    let (status, first) = call(&app, "GET", &path, Some(&token), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let cursor = first["meta"]["nextCursor"].as_str().unwrap();
    for (who, query) in [
        (&other, format!("{path}&cursor={cursor}")),
        (&token, format!("{path}&q=on&cursor={cursor}")),
        (
            &token,
            format!(
                "/entities/notes?scope=team&teamId={}&limit=1&cursor={cursor}",
                teams[0]
            ),
        ),
        (
            &token,
            format!("/entities/notes?scope=mine&limit=1&cursor={cursor}"),
        ),
    ] {
        let status = call(&app, "GET", &query, Some(who), None, &[]).await.0;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    for query in [
        "scope=team",
        "scope=team&teamId=nope",
        "scope=mine&teamId=00000000-0000-0000-0000-000000000000",
        "scope=team&teamId=00000000-0000-0000-0000-000000000000&teamId=00000000-0000-0000-0000-000000000000",
        "scope=team&unknown=x",
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/entities/notes?{query}"),
                Some(&token),
                None,
                &[]
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}
// Observe a real PostgreSQL lock wait before releasing the competing transaction.
async fn wait_for_lock(db: &PgPool, fragment: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and position($1 in query)>0)")
                .bind(fragment).fetch_one(db).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn revocation_serializes_team_mutations(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (id, token) = user(&db, &config).await;
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Race',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(id)
    .fetch_one(&db)
    .await
    .unwrap();
    for method in ["POST", "PATCH", "DELETE"] {
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member') on conflict do nothing")
            .bind(team).bind(id).execute(&db).await.unwrap();
        let (_, record) = call(
            &app,
            "POST",
            "/entities/notes",
            Some(&token),
            Some(json!({"teamId":team,"data":{"title":"race"}})),
            &[],
        )
        .await;
        let path = if method == "POST" {
            "/entities/notes".to_owned()
        } else {
            format!("/entities/notes/{}", record["data"]["id"].as_str().unwrap())
        };
        let before: i64 =
            sqlx::query_scalar("select count(*) from audit_log where action like 'record.%'")
                .fetch_one(&db)
                .await
                .unwrap();
        let mut revoke = db.begin().await.unwrap();
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(id)
            .execute(&mut *revoke)
            .await
            .unwrap();
        let task_app = app.clone();
        let task_token = token.clone();
        let task = tokio::spawn(async move {
            let body = match method {
                "POST" => Some(json!({"teamId":team,"data":{"title":"blocked"}})),
                "PATCH" => Some(json!({"data":{"title":"blocked"}})),
                _ => None,
            };
            call(
                &task_app,
                method,
                &path,
                Some(&task_token),
                body,
                &[("if-match", "1")],
            )
            .await
        });
        wait_for_lock(&db, "select m.role from teams t").await;
        revoke.commit().await.unwrap();
        assert_eq!(task.await.unwrap().0, StatusCode::NOT_FOUND);
        let after: i64 =
            sqlx::query_scalar("select count(*) from audit_log where action like 'record.%'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(before, after);
        let unchanged: (i32, bool) =
            sqlx::query_as("select version, deleted_at is null from records where id=$1")
                .bind(Uuid::parse_str(record["data"]["id"].as_str().unwrap()).unwrap())
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(unchanged, (1, true));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn mutation_before_revocation_commits_and_future_access_is_denied(db: PgPool) {
    use kernel::viewer::{Role, Viewer};
    let (app, config) = app(db.clone(), 200);
    let (id, token) = user(&db, &config).await;
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Race',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(id)
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member')")
        .bind(team)
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let source = std::fs::read_to_string("../../config/entities.json").unwrap();
    let registry = crate::registry::parse_registry(&source).unwrap();
    let viewer = Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let mut mutation = db.begin().await.unwrap();
    let record = crate::routes::create_target_in_tx(
        &mut mutation,
        &registry,
        &viewer,
        &meta,
        "notes",
        json!({"title":"committed"}),
        None,
        Some(team),
    )
    .await
    .unwrap();
    let pool = db.clone();
    let revoke = tokio::spawn(async move {
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    });
    wait_for_lock(&db, "delete from team_members").await;
    mutation.commit().await.unwrap();
    revoke.await.unwrap();
    let path = format!("/entities/notes/{}", record["id"].as_str().unwrap());
    assert_eq!(
        call(&app, "GET", &path, Some(&token), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    let count: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action='record.create' and target_id=$1",
    )
    .bind(record["id"].as_str().unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn moderation_enforces_read_and_write_policy(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;
    let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility,admin_hidden_at) values('notes',$1,$2,'public',now()) returning id")
        .bind(owner_id).bind(json!({"title":"Hidden"})).fetch_one(&db).await.unwrap();
    let path = format!("/entities/notes/{id}");
    for token in [None, Some(other.as_str())] {
        assert_eq!(
            call(&app, "GET", &path, token, None, &[]).await.0,
            StatusCode::NOT_FOUND
        );
        let (_, list) = call(
            &app,
            "GET",
            "/entities/notes?scope=public",
            token,
            None,
            &[],
        )
        .await;
        assert!(list["data"].as_array().unwrap().is_empty());
    }
    let (_, own) = call(&app, "GET", &path, Some(&owner), None, &[]).await;
    assert_eq!(own["data"]["moderationHidden"], true);
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"data":{"title":"Edited"}})),
            &[("if-match", "1")]
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, rejected) = call(
        &app,
        "PATCH",
        &path,
        Some(&owner),
        Some(json!({"visibility":"public"})),
        &[("if-match", "2")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected["error"]["code"], "VALIDATION_FAILED");
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"moderationHidden":false})),
            &[("if-match", "2")]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&owner),
            Some(json!({"data":{"title":"Bad"},"moderationHidden":false})),
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let still_hidden: bool =
        sqlx::query_scalar("select admin_hidden_at is not null from records where id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(still_hidden, "rejected PATCHes must not clear the flag");
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"visibility":"private"})),
            &[("if-match", "2")]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&other), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    let (_, after_private) = call(&app, "GET", &path, Some(&owner), None, &[]).await;
    assert_eq!(after_private["data"]["moderationHidden"], true);
    assert_eq!(after_private["data"]["visibility"], "private");
    // Simulates a future admin unhide. Only the admin area is meant to clear this flag.
    sqlx::query("update records set admin_hidden_at=null where id=$1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"visibility":"public"})),
            &[("if-match", "3")]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &path, None, None, &[]).await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_create_uses_team_role_for_admin_only_entity(db: PgPool) {
    let config = Arc::new(Config::from_env().unwrap());
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let source = std::fs::read_to_string("../../config/entities.json").unwrap();
    let mut source: Value = serde_json::from_str(&source).unwrap();
    source["notes"]["create"] = json!("admin");
    let registry = Arc::new(crate::registry::parse_registry(&source.to_string()).unwrap());
    let app = crate::router(registry).with_state(state);
    let (member_id, member) = user(&db, &config).await;
    let (viewer_id, viewer) = user(&db, &config).await;
    let (outsider_id, outsider) = user(&db, &config).await;
    sqlx::query("update users set role='admin' where id=$1")
        .bind(outsider_id)
        .execute(&db)
        .await
        .unwrap();
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Team',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(member_id)
    .fetch_one(&db)
    .await
    .unwrap();
    for (id, role) in [(member_id, "member"), (viewer_id, "viewer")] {
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,$3)")
            .bind(team)
            .bind(id)
            .bind(role)
            .execute(&db)
            .await
            .unwrap();
    }
    let body = json!({"data":{"title":"Team"},"teamId":team});
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&member),
            Some(body.clone()),
            &[]
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&viewer),
            Some(body.clone()),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&outsider),
            Some(body),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/entities/notes",
            Some(&member),
            Some(json!({"data":{"title":"Personal"}})),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn hidden_records_override_schema_read_access(db: PgPool) {
    let config = Arc::new(Config::from_env().unwrap());
    let (owner_id, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;
    let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility,admin_hidden_at) values('notes',$1,$2,'private',now()) returning id")
        .bind(owner_id).bind(json!({"title":"Hidden"})).fetch_one(&db).await.unwrap();
    for access in ["public", "authenticated"] {
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let source = std::fs::read_to_string("../../config/entities.json").unwrap();
        let mut source: Value = serde_json::from_str(&source).unwrap();
        source["notes"]["read"] = json!(access);
        let registry = Arc::new(crate::registry::parse_registry(&source.to_string()).unwrap());
        let app = crate::router(registry).with_state(state);
        let path = format!("/entities/notes/{id}");
        for token in [None, Some(other.as_str())] {
            assert_eq!(
                call(&app, "GET", &path, token, None, &[]).await.0,
                StatusCode::NOT_FOUND
            );
            let (_, list) = call(
                &app,
                "GET",
                "/entities/notes?scope=public",
                token,
                None,
                &[],
            )
            .await;
            assert!(list["data"].as_array().unwrap().is_empty());
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, &[]).await.0,
            StatusCode::OK
        );
    }
}

fn ids(list: &Value) -> Vec<String> {
    list["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect()
}

async fn make_admin(db: &PgPool, id: Uuid) {
    sqlx::query("update users set role='admin' where id=$1")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
}

/// Inserts a notes row directly, so tests can set the moderation flag and team id.
async fn insert_note(
    db: &PgPool,
    owner: Uuid,
    visibility: &str,
    hidden: bool,
    team: Option<Uuid>,
) -> Uuid {
    sqlx::query_scalar(
        "insert into records(entity,owner_id,data,visibility,admin_hidden_at,team_id) values('notes',$1,$2,$3,case when $4 then now() end,$5) returning id",
    )
    .bind(owner)
    .bind(json!({"title":"Note"}))
    .bind(visibility)
    .bind(hidden)
    .bind(team)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn insert_team(db: &PgPool, creator: Uuid, members: &[(Uuid, &str)]) -> Uuid {
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Team',$1,$2) returning id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(creator)
    .fetch_one(db)
    .await
    .unwrap();
    for &(id, role) in members {
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,$3)")
            .bind(team)
            .bind(id)
            .bind(role)
            .execute(db)
            .await
            .unwrap();
    }
    team
}

#[sqlx::test(migrations = "../../migrations")]
async fn hidden_personal_record_visibility_matrix(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;
    let (admin_id, admin) = user(&db, &config).await;
    make_admin(&db, admin_id).await;
    let id = insert_note(&db, owner_id, "public", true, None).await;
    let path = format!("/entities/notes/{id}");
    let key = id.to_string();

    // Anonymous and other owners: 404 on get, and the hidden id is absent from public lists.
    for token in [None, Some(other.as_str())] {
        assert_eq!(
            call(&app, "GET", &path, token, None, &[]).await.0,
            StatusCode::NOT_FOUND
        );
        let (_, public) = call(
            &app,
            "GET",
            "/entities/notes?scope=public",
            token,
            None,
            &[],
        )
        .await;
        assert!(!ids(&public).contains(&key));
    }

    // Owner: reads it, sees it in mine, and it is still excluded from the public scope.
    let (status, own) = call(&app, "GET", &path, Some(&owner), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(own["data"]["moderationHidden"], true);
    let (_, mine) = call(
        &app,
        "GET",
        "/entities/notes?scope=mine",
        Some(&owner),
        None,
        &[],
    )
    .await;
    assert!(ids(&mine).contains(&key));
    let (_, public) = call(
        &app,
        "GET",
        "/entities/notes?scope=public",
        Some(&owner),
        None,
        &[],
    )
    .await;
    assert!(!ids(&public).contains(&key));

    // Global admin: reads it and lists it in all, but not in the public scope.
    let (status, seen) = call(&app, "GET", &path, Some(&admin), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["data"]["moderationHidden"], true);
    let (_, all) = call(
        &app,
        "GET",
        "/entities/notes?scope=all",
        Some(&admin),
        None,
        &[],
    )
    .await;
    assert!(ids(&all).contains(&key));
    let (_, public) = call(
        &app,
        "GET",
        "/entities/notes?scope=public",
        Some(&admin),
        None,
        &[],
    )
    .await;
    assert!(!ids(&public).contains(&key));

    // Ordinary users cannot use the all scope at all.
    let (_, denied) = call(
        &app,
        "GET",
        "/entities/notes?scope=all",
        Some(&other),
        None,
        &[],
    )
    .await;
    assert_eq!(denied["error"]["code"], "FORBIDDEN");
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_hide_round_trip_bumps_version_and_touches_only_the_flag(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, _) = user(&db, &config).await;
    let id = insert_note(&db, owner_id, "public", false, None).await;
    let path = format!("/entities/notes/{id}");

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, true)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    assert_eq!(
        call(&app, "GET", &path, None, None, &[]).await.0,
        StatusCode::NOT_FOUND
    );

    // Hiding again changes nothing, so the version stays put.
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, true)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, false)
            .await
            .unwrap(),
        3
    );
    tx.commit().await.unwrap();

    let row: (i32, String, String, bool) = sqlx::query_as(
        "select version, visibility, data->>'title', admin_hidden_at is not null from records where id=$1",
    )
    .bind(id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(row, (3, "public".to_owned(), "Note".to_owned(), false));
    assert_eq!(
        call(&app, "GET", &path, None, None, &[]).await.0,
        StatusCode::OK
    );

    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, false)
            .await
            .unwrap(),
        3
    );
    tx.commit().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_records_hide_rules_and_team_visibility(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (team_owner_id, team_owner) = user(&db, &config).await;
    let (member_id, member) = user(&db, &config).await;
    let (team_admin_id, team_admin) = user(&db, &config).await;
    let (viewer_id, viewer) = user(&db, &config).await;
    let (_, outsider) = user(&db, &config).await;
    let (admin_id, admin) = user(&db, &config).await;
    make_admin(&db, admin_id).await;
    let team = insert_team(
        &db,
        team_owner_id,
        &[
            (team_owner_id, "owner"),
            (member_id, "member"),
            (team_admin_id, "admin"),
            (viewer_id, "viewer"),
        ],
    )
    .await;
    let id = insert_note(&db, member_id, "private", false, Some(team)).await;
    let path = format!("/entities/notes/{id}");
    let key = id.to_string();
    let team_scope = format!("/entities/notes?scope=team&teamId={team}");

    // The public path refuses team rows, both ways.
    let mut tx = db.begin().await.unwrap();
    let err = crate::moderation::set_personal_hidden(&mut tx, id, true)
        .await
        .unwrap_err();
    assert!(matches!(err.code, kernel::ErrorCode::ValidationFailed));
    drop(tx);
    let flag: bool =
        sqlx::query_scalar("select admin_hidden_at is not null from records where id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(!flag);

    // Admin hide is allowed. Afterwards only the record's owner and global admins can read it.
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, true)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    assert_eq!(
        call(&app, "GET", &path, Some(&member), None, &[]).await.0,
        StatusCode::OK
    );
    for token in [&team_owner, &team_admin, &viewer, &outsider, &admin] {
        assert_eq!(
            call(&app, "GET", &path, Some(token.as_str()), None, &[])
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    let (_, listed) = call(&app, "GET", &team_scope, Some(&team_admin), None, &[]).await;
    assert!(!ids(&listed).contains(&key));
    let (_, listed) = call(&app, "GET", &team_scope, Some(&member), None, &[]).await;
    assert!(ids(&listed).contains(&key));

    // Writes follow the same rule: a team admin gets 404 on a hidden row from another member.
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&team_admin),
            Some(json!({"data":{"title":"Nope"}})),
            &[("if-match", "2")]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // The record's owner keeps editing data while it is hidden.
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&member),
            Some(json!({"data":{"title":"Edited"}})),
            &[("if-match", "2")]
        )
        .await
        .0,
        StatusCode::OK
    );

    // The public path can't unhide a team row either.
    let mut tx = db.begin().await.unwrap();
    assert!(
        crate::moderation::set_personal_hidden(&mut tx, id, false)
            .await
            .is_err()
    );
    drop(tx);

    // Admin unhide returns the row to its team.
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::set_admin_hidden(&mut tx, id, false)
            .await
            .unwrap(),
        4
    );
    tx.commit().await.unwrap();
    assert_eq!(
        call(&app, "GET", &path, Some(&team_admin), None, &[])
            .await
            .0,
        StatusCode::OK
    );

    // Deleting the team removes access for everyone, including the record's owner.
    sqlx::query("update teams set deleted_at=now() where id=$1")
        .bind(team)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "GET", &path, Some(&team_admin), None, &[])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&member), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_moderation_list_pages_and_delete_restore(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, owner) = user(&db, &config).await;
    let team = insert_team(&db, owner_id, &[(owner_id, "owner")]).await;
    let hidden = insert_note(&db, owner_id, "public", true, None).await;
    let visible = insert_note(&db, owner_id, "public", false, None).await;
    let private = insert_note(&db, owner_id, "private", false, None).await;
    let team_row = insert_note(&db, owner_id, "private", false, Some(team)).await;
    let no_filter = crate::moderation::AdminFilter::default();

    // Filters: hidden only, public only. Team rows are listed too (the team row is private).
    let only_hidden = crate::moderation::admin_list(
        &db,
        "notes",
        &crate::moderation::AdminFilter {
            hidden: Some(true),
            ..Default::default()
        },
        10,
        None,
    )
    .await
    .unwrap();
    assert_eq!(only_hidden.items.len(), 1);
    assert_eq!(only_hidden.items[0].record.id, hidden);
    assert!(only_hidden.items[0].record.admin_hidden_at.is_some());
    let public = crate::moderation::admin_list(
        &db,
        "notes",
        &crate::moderation::AdminFilter {
            visibility: Some("public".into()),
            ..Default::default()
        },
        10,
        None,
    )
    .await
    .unwrap();
    assert_eq!(public.items.len(), 2);
    let every = crate::moderation::admin_list(&db, "notes", &no_filter, 10, None)
        .await
        .unwrap();
    assert_eq!(every.items.len(), 4);
    let team_item = every
        .items
        .iter()
        .find(|r| r.record.id == team_row)
        .unwrap();
    assert_eq!(team_item.record.team_id, Some(team));

    // Keyset paging over all four rows, team row included.
    let first = crate::moderation::admin_list(&db, "notes", &no_filter, 2, None)
        .await
        .unwrap();
    assert_eq!(first.items.len(), 2);
    let second = crate::moderation::admin_list(&db, "notes", &no_filter, 2, first.next)
        .await
        .unwrap();
    assert_eq!(second.items.len(), 2);
    assert!(second.next.is_none());
    let mut seen: Vec<Uuid> = first
        .items
        .iter()
        .chain(second.items.iter())
        .map(|r| r.record.id)
        .collect();
    seen.sort();
    let mut expected = vec![hidden, visible, private, team_row];
    expected.sort();
    assert_eq!(seen, expected);

    // Bad input is refused.
    assert!(
        crate::moderation::admin_list(&db, "notes", &no_filter, 0, None)
            .await
            .is_err()
    );
    assert!(
        crate::moderation::admin_list(
            &db,
            "notes",
            &crate::moderation::AdminFilter {
                visibility: Some("unlisted".into()),
                ..Default::default()
            },
            10,
            None,
        )
        .await
        .is_err()
    );

    // Soft delete hides the row from its owner, keeps the flag, and bumps the version.
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::admin_soft_delete(&mut tx, hidden)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert!(
        crate::moderation::admin_soft_delete(&mut tx, hidden)
            .await
            .is_err()
    );
    drop(tx);
    let gone = crate::moderation::admin_get(&db, "notes", hidden)
        .await
        .unwrap();
    assert!(gone.deleted_at.is_some());
    assert!(gone.record.admin_hidden_at.is_some());
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/notes/{hidden}"),
            Some(&owner),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Restore brings the row back with the flag unchanged.
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::admin_restore(&mut tx, hidden)
            .await
            .unwrap(),
        3
    );
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert!(
        crate::moderation::admin_restore(&mut tx, hidden)
            .await
            .is_err()
    );
    drop(tx);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/entities/notes/{hidden}"),
            Some(&owner),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );

    // Admin reads include team rows, and explicit admin delete and restore work on them.
    let team_get = crate::moderation::admin_get(&db, "notes", team_row)
        .await
        .unwrap();
    assert_eq!(team_get.record.team_id, Some(team));
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::admin_soft_delete(&mut tx, team_row)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        crate::moderation::admin_restore(&mut tx, team_row)
            .await
            .unwrap(),
        3
    );
    tx.commit().await.unwrap();
}

fn sorted(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort();
    ids
}

async fn admin_ids(db: &PgPool, entity: &str, filter: crate::moderation::AdminFilter) -> Vec<Uuid> {
    let page = crate::moderation::admin_list(db, entity, &filter, 100, None)
        .await
        .unwrap();
    sorted(page.items.iter().map(|r| r.record.id).collect())
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_reads_team_rows_without_membership(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner_id, owner) = user(&db, &config).await;
    let (admin_id, admin) = user(&db, &config).await;
    make_admin(&db, admin_id).await;
    // The admin is a global admin with no membership in this team.
    let team = insert_team(&db, owner_id, &[(owner_id, "owner")]).await;
    let id = insert_note(&db, owner_id, "private", false, Some(team)).await;
    let key = id.to_string();

    // Admin surface: the team row comes back with its team id.
    let got = crate::moderation::admin_get(&db, "notes", id)
        .await
        .unwrap();
    assert_eq!(got.record.team_id, Some(team));
    let page = crate::moderation::admin_list(
        &db,
        "notes",
        &crate::moderation::AdminFilter::default(),
        10,
        None,
    )
    .await
    .unwrap();
    assert!(
        page.items
            .iter()
            .any(|r| r.record.id == id && r.record.team_id == Some(team))
    );

    // Ordinary reads are unchanged: the admin without membership gets 404, the member gets 200.
    let path = format!("/entities/notes/{id}");
    assert_eq!(
        call(&app, "GET", &path, Some(&admin), None, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&owner), None, &[]).await.0,
        StatusCode::OK
    );
    let (status, listed) = call(
        &app,
        "GET",
        &format!("/entities/notes?scope=team&teamId={team}"),
        Some(&admin),
        None,
        &[],
    )
    .await;
    // A non-member gets the same 404 as for a missing team, so the team's existence isn't revealed.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!listed.to_string().contains(&key));
    let (_, listed) = call(
        &app,
        "GET",
        "/entities/notes?scope=all",
        Some(&admin),
        None,
        &[],
    )
    .await;
    assert!(!ids(&listed).contains(&key));

    // Admin hide: the public path refuses the team row, the admin path accepts it.
    let mut tx = db.begin().await.unwrap();
    let err = crate::moderation::set_personal_hidden(&mut tx, id, true)
        .await
        .unwrap_err();
    assert!(matches!(err.code, kernel::ErrorCode::ValidationFailed));
    drop(tx);
    let mut tx = db.begin().await.unwrap();
    let version = crate::moderation::set_admin_hidden(&mut tx, id, true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(version, 2);
    let hidden = crate::moderation::admin_get(&db, "notes", id)
        .await
        .unwrap();
    assert!(hidden.record.admin_hidden_at.is_some());
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_list_filters_and_cursor_include_team_rows(db: PgPool) {
    let (_app, config) = app(db.clone(), 200);
    let (owner_id, _) = user(&db, &config).await;
    let team = insert_team(&db, owner_id, &[(owner_id, "owner")]).await;
    let personal_public = insert_note(&db, owner_id, "public", false, None).await;
    let team_live = insert_note(&db, owner_id, "private", false, Some(team)).await;
    let team_hidden = insert_note(&db, owner_id, "private", true, Some(team)).await;
    let team_deleted = insert_note(&db, owner_id, "private", false, Some(team)).await;
    sqlx::query("update records set deleted_at=now() where id=$1")
        .bind(team_deleted)
        .execute(&db)
        .await
        .unwrap();
    // A team row of another entity must never show up in the notes list.
    let other_entity: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data,visibility,team_id) values('books',$1,$2,'private',$3) returning id",
    )
    .bind(owner_id)
    .bind(json!({"title":"Book"}))
    .bind(team)
    .fetch_one(&db)
    .await
    .unwrap();
    let all_notes = sorted(vec![personal_public, team_live, team_hidden, team_deleted]);

    use crate::moderation::AdminFilter;
    assert_eq!(
        admin_ids(&db, "notes", AdminFilter::default()).await,
        all_notes
    );
    assert_eq!(
        admin_ids(&db, "books", AdminFilter::default()).await,
        sorted(vec![other_entity])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                hidden: Some(true),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![team_hidden])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                hidden: Some(false),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![personal_public, team_live, team_deleted])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                deleted: Some(true),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![team_deleted])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                deleted: Some(false),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![personal_public, team_live, team_hidden])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                visibility: Some("private".into()),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![team_live, team_hidden, team_deleted])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                visibility: Some("public".into()),
                ..Default::default()
            }
        )
        .await,
        sorted(vec![personal_public])
    );
    assert_eq!(
        admin_ids(
            &db,
            "notes",
            AdminFilter {
                hidden: Some(false),
                deleted: Some(false),
                visibility: Some("private".into()),
            }
        )
        .await,
        sorted(vec![team_live])
    );

    // Cursor paging one row at a time visits every notes row exactly once, team rows included.
    let mut after = None;
    let mut seen = Vec::new();
    loop {
        let page = crate::moderation::admin_list(&db, "notes", &AdminFilter::default(), 1, after)
            .await
            .unwrap();
        assert!(page.items.len() <= 1);
        seen.extend(page.items.iter().map(|r| r.record.id));
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
        assert!(seen.len() < 10, "paging did not finish");
    }
    assert_eq!(sorted(seen), all_notes);

    // Limit bounds still apply with team rows in the table.
    assert!(
        crate::moderation::admin_list(&db, "notes", &AdminFilter::default(), 101, None)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn record_text_is_trimmed_and_required_on_create_and_patch(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (_, token) = user(&db, &config).await;
    for title in ["", "  \t  "] {
        let (status, body) = call(
            &app,
            "POST",
            "/entities/notes",
            Some(&token),
            Some(json!({"data":{"title":title}})),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"]["message"],
            "Please check the highlighted fields."
        );
        assert_eq!(body["error"]["details"][0]["path"], "title");
    }
    let (status, body) = call(
        &app,
        "POST",
        "/entities/notes",
        Some(&token),
        Some(json!({"data":{"title":"  hello  ","tags":["  one  "]}})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["data"]["title"], "hello");
    assert_eq!(body["data"]["data"]["tags"][0], "one");
    let path = format!("/entities/notes/{}", body["data"]["id"].as_str().unwrap());
    let (status, body) = call(
        &app,
        "PATCH",
        &path,
        Some(&token),
        Some(json!({"data":{"title":"  "}})),
        &[("if-match", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["details"][0]["path"], "title");
}

/// A stored row can keep a key that the schema no longer allows. PATCH must ignore that key unless
/// the request names it, and must keep the row as stored.
#[sqlx::test(migrations = "../../migrations")]
async fn patch_ignores_removed_stored_keys_unless_touched(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner, token) = user(&db, &config).await;
    let legacy: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
    )
    .bind(owner)
    .bind(json!({"title":"old","legacyKey":"kept"}))
    .fetch_one(&db)
    .await
    .unwrap();
    let path = format!("/entities/notes/{legacy}");
    // (a) An untouched removed key does not block the edit, and it is stored as it was.
    let (status, body) = call(
        &app,
        "PATCH",
        &path,
        Some(&token),
        Some(json!({"data":{"title":"new"}})),
        &[("if-match", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"]["title"], "new");
    assert_eq!(body["data"]["data"]["legacyKey"], "kept");
    // (b) Setting the removed key is rejected with the usual plain message.
    let (status, body) = call(
        &app,
        "PATCH",
        &path,
        Some(&token),
        Some(json!({"data":{"legacyKey":"again"}})),
        &[("if-match", "2")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["error"]["message"],
        "Please check the highlighted fields."
    );
    assert_eq!(
        body["error"]["details"],
        json!([{"path":"legacyKey","message":"This field isn't allowed."}])
    );
    let stored: Value = sqlx::query_scalar("select data from records where id=$1")
        .bind(legacy)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(stored, json!({"title":"new","legacyKey":"kept"}));
}

/// Touched keys are validated strictly. Untouched values are not, but required fields are always
/// checked. Text from the request is trimmed; stored text is not rewritten.
#[sqlx::test(migrations = "../../migrations")]
async fn patch_validates_touched_keys_and_required_fields(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner, token) = user(&db, &config).await;
    let too_many: Vec<String> = (0..51).map(|i| format!("t{i}")).collect();
    // Saved before the tag limit dropped to 50, so it is over the limit today.
    let over: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
    )
    .bind(owner)
    .bind(json!({"title":"  over  ","tags":too_many.clone()}))
    .fetch_one(&db)
    .await
    .unwrap();
    // Saved before `title` became required, so it has none.
    let untitled: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
    )
    .bind(owner)
    .bind(json!({"body":"no title"}))
    .fetch_one(&db)
    .await
    .unwrap();

    let over_path = format!("/entities/notes/{over}");
    let (status, body) = call(
        &app,
        "PATCH",
        &over_path,
        Some(&token),
        Some(json!({"data":{"pinned":true}})),
        &[("if-match", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"]["tags"].as_array().unwrap().len(), 51);
    assert_eq!(body["data"]["data"]["title"], "  over  ");

    let (status, body) = call(
        &app,
        "PATCH",
        &over_path,
        Some(&token),
        Some(json!({"data":{"tags":too_many}})),
        &[("if-match", "2")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"][0]["path"], "tags");
    assert_eq!(
        body["error"]["details"][0]["message"],
        "Use at most 50 items."
    );

    let untitled_path = format!("/entities/notes/{untitled}");
    let (status, body) = call(
        &app,
        "PATCH",
        &untitled_path,
        Some(&token),
        Some(json!({"data":{"body":"fixed"}})),
        &[("if-match", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"][0]["path"], "title");
    assert_eq!(
        body["error"]["details"][0]["message"],
        "This field is required."
    );

    let (status, body) = call(
        &app,
        "PATCH",
        &untitled_path,
        Some(&token),
        Some(json!({"data":{"title":"  Now titled  "}})),
        &[("if-match", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"]["title"], "Now titled");
}

/// A sort field can hold several JSON types after a schema change. The list must still return 200
/// and page through every row: values of the declared type sort first, the rest sort as null.
#[sqlx::test(migrations = "../../migrations")]
async fn sort_tolerates_mixed_stored_types(db: PgPool) {
    let (app, config) = app(db.clone(), 200);
    let (owner, token) = user(&db, &config).await;
    for data in [
        json!({"title":"a","priority":2}),
        json!({"title":"b","priority":1}),
        json!({"title":"c","priority":"high"}),
        json!({"title":"d","priority":null}),
        json!({"title":"e","priority":true}),
        json!({"title":"f"}),
    ] {
        sqlx::query("insert into records(entity,owner_id,data) values('tasks',$1,$2)")
            .bind(owner)
            .bind(data)
            .execute(&db)
            .await
            .unwrap();
    }
    for (sort, first_two) in [("priority", ["b", "a"]), ("-priority", ["a", "b"])] {
        let mut seen = Vec::new();
        let mut path = format!("/entities/tasks?sort={sort}&limit=2");
        loop {
            let (status, body) = call(&app, "GET", &path, Some(&token), None, &[]).await;
            assert_eq!(status, StatusCode::OK, "{sort}: {body}");
            for item in body["data"].as_array().unwrap() {
                seen.push(item["data"]["title"].as_str().unwrap().to_owned());
            }
            match body["meta"]["nextCursor"].as_str() {
                Some(cursor) => {
                    path = format!("/entities/tasks?sort={sort}&limit=2&cursor={cursor}");
                }
                None => break,
            }
        }
        assert_eq!(seen[..2], first_two, "{sort}");
        seen.sort();
        assert_eq!(seen, ["a", "b", "c", "d", "e", "f"], "{sort}");
    }
}
