#![allow(clippy::unwrap_used, clippy::collapsible_if)]
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
use std::sync::{Arc, Mutex};
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
fn setup(db: PgPool) -> (AppState, Arc<Capture>) {
    let mut config = Config::from_env().unwrap();
    config.breach_check = false;
    let capture = Arc::new(Capture::default());
    (
        AppState {
            db,
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: capture.clone(),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        },
        capture,
    )
}
async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = auth::router()
        .with_state(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn code(capture: &Capture) -> String {
    for _ in 0..100 {
        if let Some(email) = capture.0.lock().unwrap().last() {
            if let Some(code) = email
                .text
                .split_whitespace()
                .find(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit()))
            {
                return code.to_owned();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("email not delivered")
}
async fn signup(state: &AppState, email: &str) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/signup",
        json!({"name":"Test","email":email,"password":"strong-pass-123"}),
        None,
    )
    .await
}
async fn verify(state: &AppState, email: &str, code: &str, pending: &Value) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/verify-email",
        json!({"email":email,"code":code,"signupToken":pending["data"]["signupToken"]}),
        None,
    )
    .await
}
async fn signin(state: &AppState, email: &str, password: &str) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/signin",
        json!({"email":email,"password":password}),
        None,
    )
    .await
}
#[sqlx::test(migrations = "../../migrations")]
async fn happy_and_signout(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let (status, v) = verify(&s, "a@example.com", &pin, &pending).await;
    assert_eq!(status, StatusCode::OK);
    let token = v["data"]["token"].as_str().unwrap();
    assert_eq!(
        signin(&s, "a@example.com", "strong-pass-123").await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "POST", "/signout", json!({}), Some(token)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(token)).await.0,
        StatusCode::UNAUTHORIZED
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn failed_and_unverified(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let a = signin(&s, "a@example.com", "wrong-password").await;
    let b = signin(&s, "missing@example.com", "wrong-password").await;
    let r = signin(&s, "a@example.com", "strong-pass-123").await;
    assert_eq!(a, b);
    assert_eq!(a, r);
    assert_eq!(c.0.lock().unwrap().len(), 1);
    verify(&s, "a@example.com", &pin, &pending).await;
    sqlx::query("update users set status='suspended' where email='a@example.com'")
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        signin(&s, "a@example.com", "strong-pass-123").await.1["error"]["code"],
        "ACCOUNT_SUSPENDED"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn attempts_and_expiry(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let wrong = if pin == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        assert_eq!(
            verify(&s, "a@example.com", wrong, &pending).await.1["error"]["code"],
            "INVALID_CODE"
        );
    }
    assert_eq!(
        verify(&s, "a@example.com", &pin, &pending).await.1["error"]["code"],
        "INVALID_CODE"
    );
    let pending_b = signup(&s, "b@example.com").await.1;
    let pin = code(&c).await;
    sqlx::query(
        "update pending_signups set expires_at=now()-interval '1 second' where email='b@example.com'",
    )
    .execute(&s.db)
    .await
    .unwrap();
    assert_eq!(
        verify(&s, "b@example.com", &pin, &pending_b).await.1["error"]["code"],
        "INVALID_CODE"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn duplicate_and_long_password(db: PgPool) {
    let (s, c) = setup(db);
    let first = signup(&s, "a@example.com").await;
    let pending = first.1.clone();
    let pin = code(&c).await;
    verify(&s, "a@example.com", &pin, &pending).await;
    let second = signup(&s, "a@example.com").await;
    assert_eq!(first.0, second.0);
    assert_eq!(first.1["data"]["status"], second.1["data"]["status"]);
    assert_ne!(
        first.1["data"]["signupToken"],
        second.1["data"]["signupToken"]
    );
    for _ in 0..100 {
        if c.0.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        c.0.lock()
            .unwrap()
            .last()
            .unwrap()
            .text
            .contains("Someone tried")
    );
    let r = call(
        &s,
        "POST",
        "/signup",
        json!({"name":"Test","email":"b@example.com","password":"x".repeat(129)}),
        None,
    )
    .await;
    assert_eq!(r.1["error"]["code"], "WEAK_PASSWORD");
}
#[sqlx::test(migrations = "../../migrations")]
async fn rate_limit_has_retry_after(db: PgPool) {
    let (s, _) = setup(db);
    for _ in 0..20 {
        let response = auth::router()
            .with_state(s.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/signin")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"email":"{}@example.com","password":"wrong-password"}}"#,
                        uuid::Uuid::new_v4()
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = auth::router()
        .with_state(s)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/signin")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"email":"last@example.com","password":"wrong-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key("retry-after"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn reset_and_session_management(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let (_, v) = verify(&s, "a@example.com", &pin, &pending).await;
    let old = v["data"]["token"].as_str().unwrap().to_owned();
    c.0.lock().unwrap().clear();
    assert_eq!(
        call(
            &s,
            "POST",
            "/password/forgot",
            json!({"email":"unknown@example.com"}),
            None
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/password/forgot",
            json!({"email":"a@example.com"}),
            None
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let pin = code(&c).await;
    let (_, grant) = call(
        &s,
        "POST",
        "/password/verify-code",
        json!({"email":"a@example.com","code":pin}),
        None,
    )
    .await;
    let grant = grant["data"]["resetToken"].as_str().unwrap();
    let (_, reset) = call(
        &s,
        "POST",
        "/password/reset",
        json!({"password":"new-strong-pass-123","resetToken":grant}),
        None,
    )
    .await;
    let token = reset["data"]["token"].as_str().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            "/password/reset",
            json!({"password":"new-strong-pass-456","resetToken":grant}),
            None
        )
        .await
        .1["error"]["code"],
        "INVALID_CODE"
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(&old)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        signin(&s, "a@example.com", "new-strong-pass-123").await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(token)).await.0,
        StatusCode::OK
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn change_and_owned_sessions(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let (_, v) = verify(&s, "a@example.com", &pin, &pending).await;
    let current = v["data"]["token"].as_str().unwrap().to_owned();
    let (_, v) = signin(&s, "a@example.com", "strong-pass-123").await;
    let other = v["data"]["token"].as_str().unwrap().to_owned();
    let pending_b = signup(&s, "b@example.com").await.1;
    c.0.lock().unwrap().clear();
    // Fetch the already issued code by requesting another one after the cooldown.
    sqlx::query(
        "update pending_signups set code_sent_at=now()-interval '31 seconds' where email='b@example.com'",
    )
    .execute(&s.db)
    .await
    .unwrap();
    call(
        &s,
        "POST",
        "/resend-code",
        json!({"email":"b@example.com","purpose":"verify_email","signupToken":pending_b["data"]["signupToken"]}),
        None,
    )
    .await;
    let pin = code(&c).await;
    let (_, v) = verify(&s, "b@example.com", &pin, &pending_b).await;
    let b = v["data"]["token"].as_str().unwrap();
    let (_, list) = call(&s, "GET", "/sessions", json!({}), Some(b)).await;
    let b_id = list["data"][0]["id"].as_str().unwrap();
    let (_, list) = call(&s, "GET", "/sessions", json!({}), Some(&current)).await;
    assert_eq!(list["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["current"] == true)
            .count(),
        1
    );
    assert_eq!(
        call(
            &s,
            "DELETE",
            &format!("/sessions/{b_id}"),
            json!({}),
            Some(&current)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/password/change",
            json!({"currentPassword":"wrong-pass","newPassword":"another-strong-pass"}),
            Some(&current)
        )
        .await
        .1["error"]["code"],
        "INVALID_CREDENTIALS"
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/password/change",
            json!({"currentPassword":"strong-pass-123","newPassword":"another-strong-pass"}),
            Some(&current)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(&current))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(&other)).await.0,
        StatusCode::UNAUTHORIZED
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn demo_missing(db: PgPool) {
    let (s, _) = setup(db);
    assert_eq!(
        call(&s, "POST", "/demo", json!({}), None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn oauth_start_and_bad_state(db: PgPool) {
    let (mut s, _) = setup(db);
    Arc::make_mut(&mut s.config).google = Some(kernel::config::OAuthClient {
        client_id: "client-id".into(),
        client_secret: secrecy::SecretString::from("secret"),
    });
    let response = auth::router()
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .uri("/oauth/google/start?next=%2Fprojects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    let url = reqwest::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert!(pairs.contains_key("code_challenge"));
    assert!(pairs.contains_key("state"));
    assert_eq!(
        pairs["redirect_uri"],
        format!("{}/api/v1/auth/oauth/google/callback", s.config.app_origin)
    );
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let response = auth::router()
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .uri("/oauth/google/callback?code=test&state=wrong")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert!(
        response.headers()["location"]
            .to_str()
            .unwrap()
            .ends_with("/login?error=oauth")
    );
    let response = auth::router()
        .with_state(s)
        .oneshot(
            Request::builder()
                .uri("/oauth/github/start")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "../../migrations")]
async fn owner_second_signup_cannot_activate_attacker_credentials(db: PgPool) {
    let (s, c) = setup(db);
    // Cover both a legacy unverified users row and a new pending signup.
    let legacy = auth_password_hash(&s, "attacker-pass-123").await;
    sqlx::query(
        "insert into users(email,password_hash,display_name) values('a@example.com',$1,'Attacker')",
    )
    .bind(legacy)
    .execute(&s.db)
    .await
    .unwrap();
    let attacker = call(
        &s,
        "POST",
        "/signup",
        json!({"name":"Attacker","email":"a@example.com","password":"attacker-pass-123"}),
        None,
    )
    .await
    .1;
    let attacker_pin = code(&c).await;
    c.0.lock().unwrap().clear();
    let owner = signup(&s, "a@example.com").await.1;
    let owner_pin = code(&c).await;
    let (_, user) = verify(&s, "a@example.com", &owner_pin, &owner).await;
    assert_eq!(user["data"]["user"]["displayName"], "Test");
    assert_eq!(
        signin(&s, "a@example.com", "strong-pass-123").await.0,
        StatusCode::OK
    );
    assert_eq!(
        signin(&s, "a@example.com", "attacker-pass-123").await.1["error"]["code"],
        "INVALID_CREDENTIALS"
    );
    assert_eq!(
        verify(&s, "a@example.com", &attacker_pin, &attacker)
            .await
            .1["error"]["code"],
        "INVALID_CODE"
    );
    let count: i64 = sqlx::query_scalar("select count(*) from pending_signups")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
// Build a real legacy hash without exposing production password helpers.
async fn auth_password_hash(s: &AppState, password: &str) -> String {
    let pending = call(
        s,
        "POST",
        "/signup",
        json!({"name":"Seed","email":"seed@example.com","password":password}),
        None,
    )
    .await;
    assert_eq!(pending.0, StatusCode::ACCEPTED);
    let hash = sqlx::query_scalar(
        "delete from pending_signups where email='seed@example.com' returning password_hash",
    )
    .fetch_one(&s.db)
    .await
    .unwrap();
    sqlx::query("delete from rate_limits")
        .execute(&s.db)
        .await
        .unwrap();
    hash
}

#[sqlx::test(migrations = "../../migrations")]
async fn signup_cookie_only_and_bounded_tokens(db: PgPool) {
    let (mut s, c) = setup(db);
    Arc::make_mut(&mut s.config).secure_cookies = true;
    let response = auth::router()
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/signup")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"name":"Test","email":"a@example.com","password":"strong-pass-123"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .to_owned();
    for attr in [
        "Path=/api/v1/auth",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=900",
        "Secure",
    ] {
        assert!(cookie.contains(attr));
    }
    let users: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(users, 0);
    let pin = code(&c).await;
    let absent = call(
        &s,
        "POST",
        "/verify-email",
        json!({"email":"a@example.com","code":pin}),
        None,
    )
    .await;
    assert_eq!(absent.1["error"]["code"], "INVALID_CODE");
    let oversized = call(
        &s,
        "POST",
        "/verify-email",
        json!({"email":"a@example.com","code":pin,"signupToken":"x".repeat(129)}),
        None,
    )
    .await;
    assert_eq!(oversized.1["error"]["code"], "VALIDATION_FAILED");
    let response = auth::router()
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/verify-email")
                .header("content-type", "application/json")
                .header("cookie", cookie.split(';').next().unwrap())
                .body(Body::from(
                    json!({"email":"a@example.com","code":pin}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
    assert!(response.headers().get_all("set-cookie").iter().any(|v| {
        v.to_str()
            .unwrap()
            .starts_with(&format!("{}=", s.config.session_cookie))
    }));

    assert!(response.headers().get_all("set-cookie").iter().any(|v| {
        v.to_str()
            .unwrap()
            .contains("signup=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0; Secure")
    }));
}

#[sqlx::test(migrations = "../../migrations")]
async fn challenge_binding_resend_and_concurrent_verify(db: PgPool) {
    let (s, c) = setup(db);
    let first = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let stored: Vec<u8> =
        sqlx::query_scalar("select code_hash from pending_signups where email='a@example.com'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    let resend_body = json!({"email":"a@example.com","purpose":"verify_email","signupToken":first["data"]["signupToken"]});
    assert_eq!(
        call(&s, "POST", "/resend-code", resend_body.clone(), None)
            .await
            .0,
        StatusCode::ACCEPTED
    );
    let unchanged: Vec<u8> =
        sqlx::query_scalar("select code_hash from pending_signups where email='a@example.com'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(stored, unchanged);
    let dummy = json!({"data":{"signupToken":kernel::crypto::new_token().0}});
    assert_eq!(
        verify(&s, "a@example.com", &pin, &dummy).await.1["error"]["code"],
        "INVALID_CODE"
    );
    let wrong = if pin == "000000" { "111111" } else { "000000" };
    verify(&s, "a@example.com", wrong, &first).await;
    sqlx::query("update pending_signups set code_sent_at=now()-interval '31 seconds'")
        .execute(&s.db)
        .await
        .unwrap();
    c.0.lock().unwrap().clear();
    call(&s, "POST", "/resend-code", resend_body, None).await;
    let fresh = code(&c).await;
    let attempts: i32 =
        sqlx::query_scalar("select attempts from pending_signups where email='a@example.com'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(attempts, 1);
    let (a, b) = tokio::join!(
        verify(&s, "a@example.com", &fresh, &first),
        verify(&s, "a@example.com", &fresh, &first)
    );
    let mut statuses = vec![a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 401]);
    let sessions: i64 = sqlx::query_scalar("select count(*) from sessions")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn different_reset_grants_serialize_on_user(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    verify(&s, "a@example.com", &pin, &pending).await;
    let mut grants = Vec::new();
    for _ in 0..2 {
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into reset_grants(token_hash,user_id,expires_at) select $1,id,now()+interval '10 minutes' from users where email='a@example.com'")
            .bind(hash.as_slice()).execute(&s.db).await.unwrap();
        grants.push(token);
    }
    // Both requests must reach the user lock after hashing before either can consume a grant.
    let mut lock = s.db.begin().await.unwrap();
    sqlx::query("select id from users where email='a@example.com' for update")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for (index, grant) in grants.into_iter().enumerate() {
        let state = s.clone();
        tasks.push(tokio::spawn(async move {
            (
                index,
                call(
                    &state,
                    "POST",
                    "/password/reset",
                    json!({"password":format!("replacement-pass-{index}-123"),"resetToken":grant}),
                    None,
                )
                .await,
            )
        }));
    }
    let mut overlapped = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let waiting: i64 = sqlx::query_scalar("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select u.id,u.email%'")
            .fetch_one(&s.db).await.unwrap();
        if waiting >= 2 {
            overlapped = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    lock.commit().await.unwrap();
    assert!(
        overlapped,
        "reset requests did not overlap at the user lock"
    );
    let mut successes = Vec::new();
    for task in tasks {
        let (index, (status, body)) = task.await.unwrap();
        if status == StatusCode::OK {
            successes.push(index);
        } else {
            assert_eq!(body["error"]["code"], "INVALID_CODE");
        }
    }
    assert_eq!(successes.len(), 1);
    let used: i64 =
        sqlx::query_scalar("select count(*) from reset_grants where used_at is not null")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(used, 1);
    let winner = successes[0];
    assert_eq!(
        signin(
            &s,
            "a@example.com",
            &format!("replacement-pass-{winner}-123")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        signin(
            &s,
            "a@example.com",
            &format!("replacement-pass-{}-123", 1 - winner)
        )
        .await
        .1["error"]["code"],
        "INVALID_CREDENTIALS"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn verification_conflict_never_overwrites_registered_credentials(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    // Model OAuth or another credential flow registering this email during the pending challenge.
    sqlx::query("insert into users(email,password_hash,email_verified_at) values('a@example.com','registered-hash',now())")
        .execute(&s.db).await.unwrap();
    let result = verify(&s, "a@example.com", &pin, &pending).await;
    assert_eq!(result.0, StatusCode::CONFLICT);
    assert_eq!(
        result.1["error"]["message"],
        "This email is already registered. Sign in instead."
    );
    let hash: String =
        sqlx::query_scalar("select password_hash from users where email='a@example.com'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(hash, "registered-hash");
    assert_eq!(
        verify(&s, "a@example.com", &pin, &pending).await.1["error"]["code"],
        "INVALID_CODE"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn password_change_during_signin_cannot_issue_session_or_challenge(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    verify(&s, "a@example.com", &pin, &pending).await;
    let original: String =
        sqlx::query_scalar("select password_hash from users where email='a@example.com'")
            .fetch_one(&s.db)
            .await
            .unwrap();
    let replacement = auth_password_hash(&s, "new-strong-pass-123").await;
    for mfa in [false, true] {
        sqlx::query("update users set password_hash=$1 where email='a@example.com'")
            .bind(&original)
            .execute(&s.db)
            .await
            .unwrap();
        if mfa {
            sqlx::query("insert into mfa_totp(user_id,secret_ciphertext,secret_nonce,enabled_at) select id,'x'::bytea,'x'::bytea,now() from users where email='a@example.com'").execute(&s.db).await.unwrap();
        }
        let sessions: i64 = sqlx::query_scalar("select count(*) from sessions")
            .fetch_one(&s.db)
            .await
            .unwrap();
        let mut change = s.db.begin().await.unwrap();
        sqlx::query("update users set password_hash=$1,password_changed_at=clock_timestamp() where email='a@example.com'").bind(&replacement).execute(&mut *change).await.unwrap();
        let state = s.clone();
        let task =
            tokio::spawn(async move { signin(&state, "a@example.com", "strong-pass-123").await });
        let waiting = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let count: i64 = sqlx::query_scalar("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from users where id=$1 for update%'").fetch_one(&s.db).await.unwrap();
                if count > 0 { break; }
                tokio::task::yield_now().await;
            }
        }).await;
        change.commit().await.unwrap();
        assert!(waiting.is_ok(), "sign-in did not reach the user row lock");
        let (status, body) = task.await.unwrap();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "INVALID_CREDENTIALS");
        let after: i64 = sqlx::query_scalar("select count(*) from sessions")
            .fetch_one(&s.db)
            .await
            .unwrap();
        let challenges: i64 = sqlx::query_scalar("select count(*) from mfa_challenges")
            .fetch_one(&s.db)
            .await
            .unwrap();
        assert_eq!(after, sessions);
        assert_eq!(challenges, 0);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_password_changes_require_same_verified_hash(db: PgPool) {
    let (s, c) = setup(db);
    let pending = signup(&s, "a@example.com").await.1;
    let pin = code(&c).await;
    let (_, verified) = verify(&s, "a@example.com", &pin, &pending).await;
    let token = verified["data"]["token"].as_str().unwrap().to_owned();
    let mut blocker = s.db.begin().await.unwrap();
    sqlx::query("select id from users where email='a@example.com' for update")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for index in 0..2 {
        let s = s.clone();
        let token = token.clone();
        tasks.push(tokio::spawn(async move { call(&s,"POST","/password/change",json!({"currentPassword":"strong-pass-123","newPassword":format!("changed-pass-{index}-123")}),Some(&token)).await }));
    }
    let mut waiting = false;
    // Argon2 may compete with other workspace tests or a release build; wait for the
    // actual lock state instead of assuming both requests finish hashing within 3s.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let count: i64 = sqlx::query_scalar("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update users set password_hash=%'")
            .fetch_one(&s.db).await.unwrap();
        if count == 2 {
            waiting = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    blocker.commit().await.unwrap();
    assert!(
        waiting,
        "password changes did not overlap after verifying the old hash"
    );
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap().0.as_u16());
    }
    statuses.sort();
    assert_eq!(statuses, vec![204, 401]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn request_validation_uses_shared_envelope(db: PgPool) {
    let (state, _) = setup(db);
    for (body, path, message) in [
        (
            json!({"password":"secret"}),
            "email",
            "This field is required.",
        ),
        (
            json!({"email":42,"password":"secret"}),
            "email",
            "Must be text.",
        ),
        (
            json!({"email":"a@example.com","password":"secret","extra":true}),
            "extra",
            "This field isn't allowed.",
        ),
    ] {
        let (status, value) = call(&state, "POST", "/signin", body, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            value["error"]["message"],
            "Please check the highlighted fields."
        );
        assert_eq!(value["error"]["details"][0]["path"], path);
        assert_eq!(value["error"]["details"][0]["message"], message);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn reset_resend_has_same_accepted_body_for_known_and_unknown(db: PgPool) {
    let (s, _) = setup(db);
    sqlx::query("insert into users(email,display_name,email_verified_at) values('known@example.com','Known',now())").execute(&s.db).await.unwrap();
    let known = call(
        &s,
        "POST",
        "/resend-code",
        json!({"email":"known@example.com","purpose":"reset_password"}),
        None,
    )
    .await;
    let unknown = call(
        &s,
        "POST",
        "/resend-code",
        json!({"email":"unknown@example.com","purpose":"reset_password"}),
        None,
    )
    .await;
    assert_eq!(known.0, StatusCode::ACCEPTED);
    assert_eq!(known, unknown);
}

#[sqlx::test(migrations = "../../migrations")]
async fn reset_resend_takes_at_least_the_pad_for_known_and_unknown(db: PgPool) {
    // routes::pad sleeps 600-800 ms after every resend, so the response time doesn't reveal
    // whether an account exists. Without it, an unknown email answers in a few milliseconds
    // (and a known one only after a database write and an enqueue), which this test catches.
    // The floor is 500 ms, below the 600 ms minimum, so timer rounding can't make it flaky.
    const FLOOR: std::time::Duration = std::time::Duration::from_millis(500);
    let (s, _) = setup(db);
    sqlx::query("insert into users(email,display_name,email_verified_at) values('known@example.com','Known',now())").execute(&s.db).await.unwrap();
    for email in ["known@example.com", "unknown@example.com"] {
        let started = std::time::Instant::now();
        let (status, _) = call(
            &s,
            "POST",
            "/resend-code",
            json!({"email":email,"purpose":"reset_password"}),
            None,
        )
        .await;
        let elapsed = started.elapsed();
        assert_eq!(status, StatusCode::ACCEPTED, "{email}");
        assert!(
            elapsed >= FLOOR,
            "resend for {email} returned after {elapsed:?}, faster than the padding floor {FLOOR:?}"
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_passwords_do_not_use_up_signup_budget(db: PgPool) {
    // Every call comes from the same test IP. Before the fix, these ten rejected sign-ups
    // spent the six-per-hour IP budget and the five-per-hour per-email budget, so the valid
    // sign-ups below were refused with RATE_LIMITED.
    let (s, _) = setup(db);
    for _ in 0..10 {
        let (status, value) = call(
            &s,
            "POST",
            "/signup",
            json!({"name":"Test","email":"typo@example.com","password":"short"}),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(value["error"]["code"], "WEAK_PASSWORD");
    }
    let other = signup(&s, "fresh@example.com").await;
    assert_eq!(other.0, StatusCode::ACCEPTED, "{:?}", other.1);
    let same_email = signup(&s, "typo@example.com").await;
    assert_eq!(same_email.0, StatusCode::ACCEPTED, "{:?}", same_email.1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn valid_signups_still_respect_per_email_budget(db: PgPool) {
    // The per-account budget is five an hour. The IP sign-up budget (six) is not reached
    // first, so the sixth valid sign-up for the same address must fail on the email budget.
    let (s, _) = setup(db);
    for _ in 0..5 {
        let (status, value) = signup(&s, "a@example.com").await;
        assert_eq!(status, StatusCode::ACCEPTED, "{value:?}");
    }
    let (status, value) = signup(&s, "a@example.com").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(value["error"]["code"], "RATE_LIMITED");
}
