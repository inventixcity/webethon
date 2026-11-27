#![allow(clippy::unwrap_used)]
//! Sign-up order: local password rules run before the rate-limit budget, the outbound breach
//! check runs after it.

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{
    AppState,
    config::Config,
    email::{Email, EmailSender, SendFuture},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::net::TcpListener;
use tower::ServiceExt;

#[derive(Default)]
struct Capture(Mutex<Vec<Email>>);
impl EmailSender for Capture {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push(email.clone());
            Ok(())
        })
    }
}

/// Stands in for api.pwnedpasswords.com. The HTTP client sends every request to this local
/// listener as a proxy, so the outbound breach call can be counted without touching the internet.
/// The listener drops each connection, so the breach check fails open exactly as it does when
/// the real service is down.
async fn fake_hibp() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            // Count before closing: the client only sees the failure after the close, so the
            // count is already visible when the sign-up returns.
            counter.fetch_add(1, Ordering::SeqCst);
            drop(stream);
        }
    });
    (proxy, hits)
}

fn setup(db: PgPool, breach_check: bool, proxy: &str) -> (AppState, Arc<Capture>) {
    let mut config = Config::from_env().unwrap();
    config.breach_check = breach_check;
    let capture = Arc::new(Capture::default());
    let http = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(proxy).unwrap())
        .build()
        .unwrap();
    (
        AppState {
            db,
            config: Arc::new(config),
            http,
            email: capture.clone(),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        },
        capture,
    )
}

async fn signup(state: &AppState, email: &str, password: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/signup")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"name":"Test","email":email,"password":password}).to_string(),
        ))
        .unwrap();
    let response = auth::router_with_self_service()
        .with_state(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn local_rule_failures_spend_no_budget_and_skip_the_breach_check(db: PgPool) {
    let (proxy, hits) = fake_hibp().await;
    let (s, _) = setup(db, true, &proxy);
    let email = "alice@example.com";
    let too_long = "x".repeat(129);
    // Ten more rejections than the six-per-hour IP budget and the five-per-hour email budget.
    for _ in 0..10 {
        for password in ["short", too_long.as_str(), email] {
            let (status, value) = signup(&s, email, password).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{value:?}");
            assert_eq!(value["error"]["code"], "WEAK_PASSWORD");
        }
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "rejected passwords must not reach the outbound breach check"
    );
    // The budgets are untouched, so a valid sign-up still goes through.
    let (status, value) = signup(&s, email, "strong-pass-123").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{value:?}");
    assert!(
        hits.load(Ordering::SeqCst) >= 1,
        "valid sign-up reaches the breach check"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn breach_check_runs_only_after_the_ip_budget(db: PgPool) {
    // The sign-up IP budget is six per hour. Every request in this test shares the same
    // (unknown) client IP, so the seventh valid sign-up must be refused before the breach check.
    let (proxy, hits) = fake_hibp().await;
    let (s, _) = setup(db, true, &proxy);
    for n in 0..6 {
        let email = format!("user{n}@example.com");
        let (status, value) = signup(&s, &email, "strong-pass-123").await;
        assert_eq!(status, StatusCode::ACCEPTED, "{value:?}");
    }
    let before = hits.load(Ordering::SeqCst);
    assert!(
        before >= 6,
        "each budgeted sign-up reaches the breach check"
    );
    let (status, value) = signup(&s, "user6@example.com", "strong-pass-123").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{value:?}");
    assert_eq!(value["error"]["code"], "RATE_LIMITED");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        before,
        "a refused sign-up must not make the outbound breach call"
    );
}
