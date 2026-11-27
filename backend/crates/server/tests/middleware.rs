#![allow(clippy::expect_used)]
use axum::{
    Json,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    routing::{get, post},
};
use kernel::{
    AppState,
    config::Config,
    email::LogSender,
    security::{self, Limit, limits},
};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn session_cookie_refresh_middleware(db: PgPool) {
    use axum::{extract::State, http::HeaderMap};
    use kernel::{crypto, viewer::Viewer};

    let config = Config::from_env().expect("config");
    let cookie_name = config.session_cookie.clone();
    let state = AppState {
        db: db.clone(),
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let (token, hash) = crypto::new_token();
    sqlx::query("insert into users (email) values ('refresh@example.com')")
        .execute(&db)
        .await
        .expect("user");
    sqlx::query("insert into sessions (user_id, token_hash, expires_at) select id, $1, now() + interval '1 minute' from users where email = 'refresh@example.com'")
        .bind(hash.as_slice()).execute(&db).await.expect("session");
    let storage = files::storage_from_env().expect("storage");
    let hub = realtime::spawn_listener(db.clone(), std::future::pending())
        .await
        .expect("hub");
    let router = axum::Router::new()
        .route("/test/viewer", get(|_viewer: Viewer| async { "ok" }))
        .route(
            "/test/clear",
            get(
                |_viewer: Viewer, State(state): State<AppState>| async move {
                    let mut headers = HeaderMap::new();
                    headers.append(
                        header::SET_COOKIE,
                        "signup=keep; Path=/".parse().expect("cookie"),
                    );
                    headers.append(
                        header::SET_COOKIE,
                        kernel::session::clear_cookie(&state.config),
                    );
                    headers
                },
            ),
        )
        .route(
            "/test/other",
            get(|_viewer: Viewer| async { [(header::SET_COOKIE, "signup=keep; Path=/")] }),
        );
    let app = server::finish_router(router, state, storage, hub);
    for (path, authorization, expected) in [
        ("/test/viewer", "cookie", 1),
        ("/test/viewer", "fresh", 0),
        ("/test/viewer", "none", 0),
        ("/test/viewer", "bearer", 0),
        ("/test/clear", "cookie", 2),
        ("/test/other", "cookie", 2),
    ] {
        if authorization != "fresh" {
            sqlx::query("update sessions set expires_at = now() + interval '1 minute' where token_hash = $1")
                .bind(hash.as_slice()).execute(&db).await.expect("age session");
        }
        let mut request = Request::builder().uri(path);
        if authorization == "cookie" || authorization == "fresh" {
            request = request.header(header::COOKIE, format!("{cookie_name}={token}"));
        } else if authorization == "bearer" {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        assert_eq!(
            response.status(),
            if authorization == "none" {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::OK
            }
        );
        let cookies: Vec<_> = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().expect("cookie header"))
            .collect();
        assert_eq!(
            cookies.len(),
            expected,
            "{path} {authorization}: {cookies:?}"
        );
        if path == "/test/clear" {
            assert!(
                cookies
                    .iter()
                    .any(|value| value.starts_with(&format!("{cookie_name}="))
                        && value.contains("Max-Age=0"))
            );
            assert!(cookies.iter().any(|value| value.starts_with("signup=keep")));
        } else if path == "/test/other" {
            assert!(cookies.iter().any(|value| value.starts_with("signup=keep")));
            assert!(
                cookies
                    .iter()
                    .any(|value| value.starts_with(&format!("{cookie_name}={token}")))
            );
        } else if authorization == "cookie" {
            assert!(cookies[0].starts_with(&format!("{cookie_name}={token}")));
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn middleware_contract(db: PgPool) {
    let recorder = metrics_exporter_prometheus::PrometheusBuilder::new().build_recorder();
    let metrics = recorder.handle();
    metrics::set_global_recorder(recorder).expect("metrics recorder");
    let mut config = Config::from_env().expect("config");
    config.max_body_bytes = 1024 * 1024;
    let path =
        std::env::temp_dir().join(format!("server-test-registry-{}.json", std::process::id()));
    std::fs::write(&path, "{}").expect("write registry");
    let registry = records::load_registry(&path).expect("registry");
    config.entities_path = path.to_string_lossy().into_owned();
    let state = AppState {
        db,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let mut jobs_registry = jobs::Registry::new();
    jobs::register_email(
        &mut jobs_registry,
        Arc::new(LogSender),
        state.config.clone(),
    )
    .expect("register email");
    webhooks::register_jobs(&mut jobs_registry, state.clone()).expect("register webhooks");
    assert!(webhooks::register_jobs(&mut jobs_registry, state.clone()).is_err());
    std::fs::remove_file(path).expect("remove registry");
    // Development defaults: local file storage in ./storage, which this test never writes to.
    let storage = files::storage_from_env().expect("storage");
    let hub = realtime::spawn_listener(state.db.clone(), std::future::pending())
        .await
        .expect("realtime hub");
    let cookie_name = state.config.session_cookie.clone();
    let db = state.db.clone();
    let router = server::build_router(Arc::new(registry))
        .route(
            "/test/panic",
            get(|| async { panic!("secret panic message") }),
        )
        .route(
            "/test/json",
            post(|Json(value): Json<serde_json::Value>| async move { Json(value) }),
        )
        .route("/test/items/{id}", get(|| async { "ok" }))
        .route(
            "/test/cache",
            get(|| async { ([(header::CACHE_CONTROL, "private, max-age=3600")], "file") }),
        );
    let app = server::finish_router(router, state, storage, hub);
    // Invigil routes that must reject an unauthenticated caller before any handler work.
    for (method, uri, content_type) in [
        ("GET", "/api/v1/questions", "application/json"),
        ("GET", "/api/v1/exams", "application/json"),
        ("GET", "/api/v1/me/exams", "application/json"),
        ("GET", "/api/v1/admin/users", "application/json"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", content_type)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    let failure = futures::stream::once(async {
        Err::<bytes::Bytes, _>(std::io::Error::other("private body failure"))
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/test/json")
                .header("content-type", "application/json")
                .body(Body::from_stream(failure))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
    assert_eq!(value["error"]["code"], "BAD_REQUEST");
    assert!(!String::from_utf8_lossy(&body).contains("private body failure"));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/test/panic")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    assert!(!String::from_utf8_lossy(&body).contains("secret panic message"));
    let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
    assert_eq!(value["error"]["code"], "INTERNAL");

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .header("x-request-id", "valid-id-123")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-request-id"], "valid-id-123");
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/missing")
                .header("x-request-id", "bad")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    assert_ne!(response.headers()["x-request-id"], "bad");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
    assert_eq!(value["error"]["code"], "NOT_FOUND");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missing")
                .header("content-type", "text/plain")
                .body(Body::from("abc"))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missing")
                .header("cookie", format!("{cookie_name}=token"))
                .header("origin", "https://evil.example")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
    assert_eq!(value["error"]["code"], "CSRF_REJECTED");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missing")
                .header("authorization", "Bearer token")
                .header("origin", "https://evil.example")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_ne!(response.status(), StatusCode::FORBIDDEN);

    for body in [
        "{".to_owned(),
        format!("{}0{}", "[".repeat(64), "]".repeat(64)),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/test/json")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 4096).await.expect("body");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
        assert!(value["error"]["code"].is_string());
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/healthz")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
    assert_eq!(value["error"]["code"], "METHOD_NOT_ALLOWED");

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/test/cache")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.headers()["cache-control"], "private, max-age=3600");
    // File downloads are not mounted in Invigil (no upload surface), so their caching is not exercised here.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/test/items/123")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let rendered = metrics.render();
    assert!(
        rendered.contains("route=\"/test/items/{id}\""),
        "{rendered}"
    );
    assert!(rendered.contains("route=\"<unmatched>\""), "{rendered}");
    assert!(!rendered.contains("/test/items/123"), "{rendered}");
    for (method, uri, content_type, size, expected) in [
        (
            "POST",
            "/api/v1/entities/books/import",
            "text/plain",
            3,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "POST",
            "/api/v1/entities/books/import",
            "multipart/form-data; boundary=x",
            4 * 1024 * 1024 + 64 * 1024 + 1,
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "POST",
            "/api/v1/entities/books/import/extra",
            "multipart/form-data; boundary=x",
            3,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "PUT",
            "/api/v1/entities/books/import",
            "multipart/form-data; boundary=x",
            3,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", content_type)
                    .body(Body::from("x".repeat(size)))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), expected);
        let body = to_bytes(response.into_body(), 4096).await.expect("body");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON error");
        assert!(value["error"]["code"].is_string());
    }
    for uri in ["/api/v1/exams", "/api/v1/verify/INVALID-CODE"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["x-frame-options"], "DENY");
        let cache_control = response.headers()["cache-control"]
            .to_str()
            .expect("cache-control");
        let directives: Vec<_> = cache_control.split(',').map(str::trim).collect();
        assert!(directives.contains(&"no-store"));
    }
    let multipart = format!(
        "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n{}\r\n--boundary--\r\n",
        "x".repeat(3 * 1024 * 1024)
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/files")
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(multipart))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_ne!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let key = "api:read:ip:unknown";
    security::rate_limit_hit(
        &db,
        key,
        Limit {
            limit: 1,
            window: std::time::Duration::from_secs(60),
        },
    )
    .await
    .expect("prefill");
    // Prefill with a tiny budget but use enough hits to exhaust the server's normal budget.
    for _ in 0..kernel::security::limits::API_READ_PER_SUBJECT.limit {
        security::rate_limit_hit(
            &db,
            key,
            Limit {
                limit: 1,
                window: std::time::Duration::from_secs(60),
            },
        )
        .await
        .expect("prefill");
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/missing")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key("retry-after"));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missing")
                .header("content-type", "application/json")
                .body(Body::from("x".repeat(2 * 1024 * 1024)))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[sqlx::test(migrations = "../../migrations")]
async fn telemetry_counts_router_outcomes_and_redacts_labels(db: PgPool) {
    let mut config = Config::from_env().expect("config");
    config.trusted_proxy_hops = 0;
    let cookie = config.session_cookie.clone();
    let state = AppState {
        db: db.clone(),
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let storage = files::storage_from_env().expect("storage");
    let hub = realtime::spawn_listener(db.clone(), std::future::pending())
        .await
        .expect("hub");
    let router = axum::Router::new()
        .route("/api/v1/items/{id}", get(|| async { "ok" }))
        .route(
            "/api/v1/json",
            post(|Json(value): Json<serde_json::Value>| async move { Json(value) }),
        )
        .route("/api/v1/boom", get(|| async { panic!("boom") }))
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/v1/health", get(|| async { "ok" }));
    let app = server::finish_router(router, state, storage, hub);
    let requests = [
        Request::builder().uri("/api/v1/items/123e4567-e89b-12d3-a456-426614174000?code=privatecode&password=privatepassword&token=privatetoken").body(Body::empty()).expect("request"),
        Request::builder().method("POST").uri("/api/v1/json").header("content-type", "application/json").body(Body::from("{" )).expect("request"),
        Request::builder().method("POST").uri("/api/v1/json").header("cookie", format!("{cookie}=fake")).header("origin", "https://evil.example").body(Body::empty()).expect("request"),
        Request::builder().uri("/api/v1/unrecognized/123e4567-e89b-12d3-a456-426614174000?token=privatetoken").body(Body::empty()).expect("request"),
        Request::builder().uri("/api/v1/boom?code=privatecode").body(Body::empty()).expect("request"),
        Request::builder().uri("/healthz").body(Body::empty()).expect("request"),
        Request::builder().uri("/api/v1/health").body(Body::empty()).expect("request"),
    ];
    for (request, expected) in requests
        .into_iter()
        .zip([200, 400, 403, 404, 500, 200, 200])
    {
        assert_eq!(
            app.clone()
                .oneshot(request)
                .await
                .expect("response")
                .status()
                .as_u16(),
            expected
        );
    }
    // Keys are hashed inside rate_limit_hit, so prefill through it instead of writing the row.
    // The unauthenticated peer's subject is "ip:unknown" because the unsigned x-client-ip below is ignored.
    for _ in 0..limits::API_READ_PER_SUBJECT.limit {
        security::rate_limit_hit(&db, "api:read:ip:unknown", limits::API_READ_PER_SUBJECT)
            .await
            .expect("prefill");
    }
    let request = Request::builder()
        .uri("/api/v1/items/123e4567-e89b-12d3-a456-426614174000?code=privatecode")
        .header("x-client-ip", "192.0.2.1")
        .header("x-client-ip-signature", "invalid")
        .body(Body::empty())
        .expect("request");
    assert_eq!(
        app.clone()
            .oneshot(request)
            .await
            .expect("response")
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(app);
    tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            let total: i64 = sqlx::query_scalar(
                "select coalesce(sum(count), 0)::bigint from http_request_stats",
            )
            .fetch_one(&db)
            .await
            .expect("stats");
            if total == 6 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("collector drain");
    let rows: Vec<(String, String, i16, i64)> = sqlx::query_as(
        "select method, route, status, count from http_request_stats order by status",
    )
    .fetch_all(&db)
    .await
    .expect("rows");
    // Exactly one row per outcome: a count added by an outer or inner layer would show up here.
    assert_eq!(
        rows.iter().map(|r| (r.2, r.3)).collect::<Vec<_>>(),
        vec![(200, 1), (400, 1), (403, 1), (404, 1), (429, 1), (500, 1)]
    );
    assert!(rows.iter().any(|r| r.1 == "/api/v1/items/{id}"));
    assert!(rows.iter().any(|r| r.1 == "/api/v1/boom"));
    assert!(rows.iter().any(|r| r.1 == "<unmatched>"));
    for (method, route, _, _) in rows {
        for private in [
            "privatecode",
            "privatepassword",
            "privatetoken",
            "123e4567-e89b-12d3-a456-426614174000",
        ] {
            assert!(!method.contains(private) && !route.contains(private));
        }
    }
}

/// Statistics are written in the background. A stalled database must never hold up a response.
#[sqlx::test(migrations = "../../migrations")]
async fn stalled_statistics_storage_does_not_delay_responses(db: PgPool) {
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().expect("config")),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let storage = files::storage_from_env().expect("storage");
    let hub = realtime::spawn_listener(db.clone(), std::future::pending())
        .await
        .expect("hub");
    let router = axum::Router::new().route("/api/v1/items/{id}", get(|| async { "ok" }));
    let app = server::finish_router(router, state, storage, hub);
    // While this transaction holds the lock, every statistics write waits.
    let mut lock = db.begin().await.expect("transaction");
    sqlx::query("lock table http_request_stats in access exclusive mode")
        .execute(&mut *lock)
        .await
        .expect("lock");
    for _ in 0..3 {
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            app.clone().oneshot(
                Request::builder()
                    .uri("/api/v1/items/1")
                    .body(Body::empty())
                    .expect("request"),
            ),
        )
        .await
        .expect("a response waited on statistics storage");
        assert_eq!(response.expect("response").status(), StatusCode::OK);
    }
    lock.rollback().await.expect("release lock");
}
