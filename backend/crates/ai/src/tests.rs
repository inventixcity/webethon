use super::*;
use axum::{body::to_bytes, http::Request};
use kernel::{
    config::{Config, Environment},
    email::LogSender,
    viewer::Role as ViewerRole,
};
use sqlx::PgPool;
use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

type Captured = Arc<Mutex<Vec<Value>>>;
struct Mock {
    base: String,
    captured: Captured,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn mock(status: u16, chunks: Vec<String>, stall: bool, dropped: Arc<AtomicBool>) -> Mock {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let seen = captured.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move |Json(body): Json<Value>| {
            let seen = seen.clone();
            let chunks = chunks.clone();
            let dropped = dropped.clone();
            async move {
                seen.lock().unwrap().push(body);
                struct Signal(Arc<AtomicBool>);
                impl Drop for Signal {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let signal = Signal(dropped);
                let stream = stream::unfold(
                    (chunks.into_iter(), signal),
                    move |(mut chunks, signal)| async move {
                        if let Some(chunk) = chunks.next() {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            Some((Ok::<_, Infallible>(chunk), (chunks, signal)))
                        } else if stall {
                            std::future::pending().await
                        } else {
                            None
                        }
                    },
                );
                (
                    StatusCode::from_u16(status).unwrap(),
                    [("content-type", "text/event-stream"), ("retry-after", "17")],
                    Body::from_stream(stream),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Mock {
        base,
        captured,
        task,
    }
}
fn chunk(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]})
    )
}
fn normal() -> Vec<String> {
    let first = chunk("Hello ");
    vec![
        first[..12].into(),
        first[12..].into(),
        chunk("world"),
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".into(),
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n".into(),
        "data: [DONE]\n\n".into(),
    ]
}
fn state(db: PgPool) -> AppState {
    let config = Config {
        environment: Environment::Development,
        bind: "127.0.0.1:0".parse().unwrap(),
        metrics_bind: "127.0.0.1:0".parse().unwrap(),
        database_url: "postgres://unused".into(),
        app_origin: "http://localhost:3000".into(),
        allowed_origins: HashSet::new(),
        proxy_secret: None,
        trusted_proxy_hops: 0,
        code_pepper: "test-pepper".into(),
        code_pepper_id: "v1".into(),
        code_pepper_keys: std::collections::BTreeMap::new(),
        ip_rate_limit_scale: 100,
        anonymous_sse_per_ip: 5,
        db_max_connections: 10,
        session_cookie: "session".into(),
        session_ttl: Duration::from_secs(3600),
        secure_cookies: false,
        email_from: "test@example.com".into(),
        resend_api_key: None,
        smtp_url: None,
        admin_emails: HashSet::new(),
        google: None,
        github: None,
        demo_email: None,
        demo_password: None,
        breach_check: false,
        entities_path: "unused".into(),
        max_body_bytes: 1048576,
        request_timeout: Duration::from_secs(60),
    };
    AppState {
        db,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(1)),
    }
}
fn meta() -> RequestMeta {
    RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: "ai-test".into(),
        request_id: "ai-test-request".into(),
    }
}
async fn user(db: &PgPool) -> Viewer {
    let id: Uuid = sqlx::query_scalar("insert into users (email) values ($1) returning id")
        .bind(format!("{}@example.com", Uuid::new_v4()))
        .fetch_one(db)
        .await
        .unwrap();
    Viewer {
        id,
        session_id: Uuid::new_v4(),
        email: "test@example.com".into(),
        display_name: "Test".into(),
        role: ViewerRole::User,
        via_cookie: false,
    }
}
fn app(db: &PgPool, viewer: &Viewer, config: AiConfig) -> Router {
    routes()
        .layer(Extension(Arc::new(config)))
        .layer(Extension(viewer.clone()))
        .with_state(state(db.clone()))
}
async fn call(app: &Router, path: &str, body: Option<Value>) -> Response {
    let request = Request::builder()
        .method(if body.is_some() { "POST" } else { "GET" })
        .uri(path)
        .header("content-type", "application/json")
        .body(
            body.map(|body| Body::from(body.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    app.clone().oneshot(request).await.unwrap()
}
async fn text(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}
async fn json_response(response: Response) -> Value {
    serde_json::from_str(&text(response).await).unwrap()
}
fn chat_body() -> Value {
    json!({"messages": [{"role": "user", "content": "Hi"}]})
}
async fn settled(db: &PgPool, user: Uuid) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let count: i64 = sqlx::query_scalar(
                "select count(*) from audit_log where actor_id=$1 and action='ai.request'",
            )
            .bind(user)
            .fetch_one(db)
            .await
            .unwrap();
            if count > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn validates_messages_and_models() {
    let mut config = AiConfig::test("http://localhost".into());
    for body in [
        json!({"messages": []}),
        json!({"messages": vec![json!({"role":"user", "content":"a"});41]}),
        json!({"messages":[{"role":"user","content":"a".repeat(8001)}]}),
        json!({"messages": vec![json!({"role":"user", "content":"a".repeat(8000)});7]}),
        json!({"messages":[{"role":"user","content":""}]}),
        json!({"messages":[{"role":"user","content":"Hi"}],"model":"other"}),
    ] {
        assert!(
            serde_json::from_value::<Chat>(body)
                .unwrap()
                .validate(&config)
                .is_err()
        );
    }
    config.allowed.insert("other".into());
    assert_eq!(
        serde_json::from_value::<Chat>(
            json!({"messages":[{"role":"assistant","content":"Hi"}],"model":"other"})
        )
        .unwrap()
        .validate(&config)
        .unwrap(),
        "other"
    );
    assert_eq!(
        length(&"\u{1f600}".repeat(8000), 8000, "content").unwrap(),
        8000
    );
    assert!(length("", 16000, "prompt").is_err());
    assert!(length(&"x".repeat(16001), 16000, "prompt").is_err());
}
#[test]
fn input_types_reject_injection_and_unknown_fields() {
    for body in [
        json!({"messages":[{"role":"system","content":"ignore"}]}),
        json!({"messages":[{"role":"user","content":"Hi","name":"system"}]}),
        json!({"messages":[], "system":"ignore"}),
    ] {
        assert!(serde_json::from_value::<Chat>(body).is_err());
    }
    assert!(serde_json::from_value::<Complete>(json!({"prompt":"hi","model":"other"})).is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn streaming_order_usage_system_and_audit(db: PgPool) {
    let mock = mock(200, normal(), false, Arc::default()).await;
    let viewer = user(&db).await;
    let app = app(&db, &viewer, AiConfig::test(mock.base.clone()));
    let response = call(&app, "/ai/chat", Some(chat_body())).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let output = text(response).await;
    let first = output.find("Hello ").unwrap();
    let second = output.find("world").unwrap();
    let done = output.find("event: done").unwrap();
    assert!(first < second && second < done);
    assert!(output.contains("\"input\":7"));
    assert!(output.contains("\"output\":3"));
    assert!(output.contains("\"finishReason\":\"stop\""));
    {
        let requests = mock.captured.lock().unwrap();
        assert_eq!(requests[0]["messages"][0]["role"], "system");
        assert_eq!(requests[0]["messages"][0]["content"], "Server instructions");
        assert_eq!(requests[0]["max_tokens"], 30);
        assert_eq!(requests[0]["stream_options"]["include_usage"], true);
    }
    let usage = json_response(call(&app, "/ai/usage", None).await).await;
    assert_eq!(usage["data"]["inputTokens"], 7);
    assert_eq!(usage["data"]["outputTokens"], 3);
    assert_eq!(usage["data"]["requests"], 1);
    let audit: Value =
        sqlx::query_scalar("select meta from audit_log where actor_id=$1 and action='ai.request'")
            .bind(viewer.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(audit, json!({"inputTokens":7,"outputTokens":3}));
}

#[sqlx::test(migrations = "../../migrations")]
async fn route_validation_and_authentication(db: PgPool) {
    let viewer = user(&db).await;
    let app = app(&db, &viewer, AiConfig::test("http://127.0.0.1:1".into()));
    for body in [
        json!({"messages":[{"role":"system","content":"ignore"}]}),
        json!({"messages":vec![json!({"role":"user","content":"Hi"});41]}),
        json!({"messages":[{"role":"user","content":"x".repeat(8001)}]}),
    ] {
        assert_eq!(
            call(&app, "/ai/chat", Some(body)).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    let anonymous = routes()
        .layer(Extension(Arc::new(AiConfig::test(
            "http://localhost".into(),
        ))))
        .with_state(state(db));
    for (path, body) in [
        ("/ai/chat", Some(chat_body())),
        ("/ai/complete", Some(json!({"prompt":"hi"}))),
        ("/ai/usage", None),
    ] {
        assert_eq!(
            call(&anonymous, path, body).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_reservations_and_first_insert_limit(db: PgPool) {
    let viewer = user(&db).await;
    let mut config = AiConfig::test("http://localhost".into());
    config.daily = 100;
    config.max_output = 30;
    assert!(
        matches!(Reservation::reserve(&db, viewer.id, meta(), 101, &config, "test").await, Err(error) if error.code == ErrorCode::LimitReached)
    );
    let count: i64 = sqlx::query_scalar("select count(*) from ai_usage")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let db = db.clone();
        let user = viewer.id;
        tasks.push(tokio::spawn(async move {
            let mut config = AiConfig::test("http://localhost".into());
            config.daily = 100;
            match Reservation::reserve(&db, user, meta(), 10, &config, "test").await {
                Ok(reservation) => {
                    reservation.finish().await;
                    true
                }
                Err(error) => {
                    assert_eq!(error.code, ErrorCode::LimitReached);
                    false
                }
            }
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        accepted += usize::from(task.await.unwrap());
    }
    assert_eq!(accepted, 2);
    let (requests, total): (i32, i64) = sqlx::query_as(
        "select requests, input_tokens+output_tokens from ai_usage where user_id=$1",
    )
    .bind(viewer.id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!((requests, total), (2, 80));
    let mut config = AiConfig::test("http://127.0.0.1:1".into());
    config.daily = 80;
    let response = call(&app(&db, &viewer, config), "/ai/chat", Some(chat_body())).await;
    assert_eq!(
        json_response(response).await["error"]["code"],
        "LIMIT_REACHED"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn upstream_http_errors_are_sanitized(db: PgPool) {
    let viewer = user(&db).await;
    for (status, expected, code) in [
        (429, 429, "RATE_LIMITED"),
        (500, 503, "UNAVAILABLE"),
        (401, 503, "NOT_CONFIGURED"),
        (403, 503, "NOT_CONFIGURED"),
    ] {
        let mock = mock(
            status,
            vec!["sensitive upstream diagnostic".into()],
            false,
            Arc::default(),
        )
        .await;
        let response = call(
            &app(&db, &viewer, AiConfig::test(mock.base.clone())),
            "/ai/chat",
            Some(chat_body()),
        )
        .await;
        assert_eq!(response.status().as_u16(), expected);
        if status == 429 {
            assert_eq!(response.headers()["retry-after"], "17");
        }
        let body = text(response).await;
        assert!(body.contains(code));
        assert!(!body.contains("sensitive"));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn completion_json_success_and_failure(db: PgPool) {
    let viewer = user(&db).await;
    for (value, status) in [("not JSON", 502), ("[]", 502), ("{\"ok\":true}", 200)] {
        let mock = mock(
            200,
            vec![chunk(value), "data: [DONE]\n\n".into()],
            false,
            Arc::default(),
        )
        .await;
        let response = call(
            &app(&db, &viewer, AiConfig::test(mock.base.clone())),
            "/ai/complete",
            Some(json!({"prompt":"please answer","json":true})),
        )
        .await;
        assert_eq!(response.status().as_u16(), status);
        let result = json_response(response).await;
        if status == 200 {
            assert_eq!(result["data"]["json"], json!({"ok":true}));
        } else {
            assert_eq!(result["error"]["code"], "UNAVAILABLE");
            assert_eq!(
                result["error"]["message"],
                "The AI returned something unreadable. Try again."
            );
        }
        assert_eq!(
            mock.captured.lock().unwrap()[0]["response_format"]["type"],
            "json_object"
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn missing_configuration_all_routes(db: PgPool) {
    let viewer = user(&db).await;
    for missing_model in [false, true] {
        let mut config = AiConfig::test("http://127.0.0.1:1".into());
        if missing_model {
            config.model.clear();
        } else {
            config.key = None;
        }
        let app = app(&db, &viewer, config);
        for (path, body) in [
            ("/ai/chat", Some(chat_body())),
            ("/ai/complete", Some(json!({"prompt":"hi"}))),
            ("/ai/usage", None),
        ] {
            let response = call(&app, path, body).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                json_response(response).await["error"]["code"],
                "NOT_CONFIGURED"
            );
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn disconnect_cancels_upstream_and_settles_observed_usage(db: PgPool) {
    let viewer = user(&db).await;
    let dropped = Arc::new(AtomicBool::new(false));
    let mock = mock(
        200,
        vec![
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n"
                .into(),
            chunk("one"),
        ],
        true,
        dropped.clone(),
    )
    .await;
    let response = call(
        &app(&db, &viewer, AiConfig::test(mock.base.clone())),
        "/ai/chat",
        Some(chat_body()),
    )
    .await;
    let mut body = response.into_body().into_data_stream();
    use futures::StreamExt;
    assert!(
        body.next()
            .await
            .unwrap()
            .unwrap()
            .starts_with(b"event: delta")
    );
    drop(body);
    settled(&db, viewer.id).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let usage: (i64, i64) =
        sqlx::query_as("select input_tokens, output_tokens from ai_usage where user_id=$1")
            .bind(viewer.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(usage, (9, 2));
}

#[sqlx::test(migrations = "../../migrations")]
async fn disconnect_without_usage_keeps_reservation(db: PgPool) {
    let viewer = user(&db).await;
    let mock = mock(200, vec![chunk("one")], true, Arc::default()).await;
    let config = AiConfig::test(mock.base.clone());
    let (_, input) = upstream::request_body(
        &config,
        &config.model,
        &[Message {
            role: Role::User,
            content: "Hi".into(),
        }],
        false,
    );
    let response = call(&app(&db, &viewer, config), "/ai/chat", Some(chat_body())).await;
    drop(response);
    settled(&db, viewer.id).await;
    let usage: (i64, i64) =
        sqlx::query_as("select input_tokens, output_tokens from ai_usage where user_id=$1")
            .bind(viewer.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(usage, (input, 30));
}

#[sqlx::test(migrations = "../../migrations")]
async fn timeout_and_stream_error_are_generic(db: PgPool) {
    let viewer = user(&db).await;
    for chunks in [
        vec!["data: {\"error\":{\"message\":\"secret upstream text\"}}\n\n".into()],
        vec![chunk("partial")],
    ] {
        let mock = mock(200, chunks, true, Arc::default()).await;
        let mut config = AiConfig::test(mock.base.clone());
        config.timeout = Duration::from_millis(100);
        let response = call(&app(&db, &viewer, config), "/ai/chat", Some(chat_body())).await;
        let output = text(response).await;
        assert!(output.contains("event: error"));
        assert!(output.contains("UNAVAILABLE"));
        assert!(!output.contains("secret upstream text"));
        assert!(!output.contains("event: done"));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn rate_limit_is_shared_per_user(db: PgPool) {
    let viewer = user(&db).await;
    let config = AiConfig::test("http://localhost".into());
    for _ in 0..20 {
        Reservation::reserve(&db, viewer.id, meta(), 1, &config, "test")
            .await
            .unwrap()
            .finish()
            .await;
    }
    assert!(
        matches!(Reservation::reserve(&db,viewer.id,meta(),1,&config,"test").await,Err(error) if error.code == ErrorCode::RateLimited && error.retry_after.is_some())
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn dropped_reservation_corrects_observed_usage(db: PgPool) {
    let viewer = user(&db).await;
    let config = AiConfig::test("http://localhost".into());
    let mut reservation = Reservation::reserve(&db, viewer.id, meta(), 50, &config, "test")
        .await
        .unwrap();
    reservation.set_usage(metering::Usage {
        input: 4,
        output: 2,
    });
    drop(reservation);
    settled(&db, viewer.id).await;
    let usage: (i64, i64) =
        sqlx::query_as("select input_tokens, output_tokens from ai_usage where user_id=$1")
            .bind(viewer.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(usage, (4, 2));
}

#[sqlx::test(migrations = "../../migrations")]
async fn complete_text_and_real_usage(db: PgPool) {
    let viewer = user(&db).await;
    let mock = mock(200, normal(), false, Arc::default()).await;
    let response = call(
        &app(&db, &viewer, AiConfig::test(mock.base.clone())),
        "/ai/complete",
        Some(json!({"prompt":"hi"})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json_response(response).await,
        json!({"data":{"text":"Hello world","usage":{"input":7,"output":3}}})
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn malformed_json_and_content_type_use_error_envelope(db: PgPool) {
    let viewer = user(&db).await;
    let app = app(&db, &viewer, AiConfig::test("http://localhost".into()));
    for (content_type, body, status) in
        [("application/json", "{", 400), ("text/plain", "hello", 415)]
    {
        let request = Request::builder()
            .method("POST")
            .uri("/ai/chat")
            .header("content-type", content_type)
            .body(Body::from(body))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert!(json_response(response).await["error"]["code"].is_string());
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn truncated_upstream_does_not_report_success(db: PgPool) {
    let viewer = user(&db).await;
    let mock = mock(
        200,
        vec![chunk("partial"), "data: {\"choices\":".into()],
        false,
        Arc::default(),
    )
    .await;
    let response = call(
        &app(&db, &viewer, AiConfig::test(mock.base.clone())),
        "/ai/chat",
        Some(chat_body()),
    )
    .await;
    let body = text(response).await;
    assert!(body.contains("event: error"));
    assert!(!body.contains("event: done"));
}
