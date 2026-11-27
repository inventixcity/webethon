#![allow(clippy::unwrap_used)]
use argon2::{
    Argon2, PasswordHasher,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use hmac::{Hmac, Mac};
use kernel::{AppState, config::Config, email::LogSender};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn call(
    router: Router<AppState>,
    state: &AppState,
    token: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = router
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
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
fn totp(secret: &str, offset: i64) -> String {
    let (mut buffer, mut bits) = (0u32, 0u32);
    let mut decoded = Vec::new();
    for b in secret.bytes() {
        let n = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
            .iter()
            .position(|c| *c == b)
            .unwrap() as u32;
        buffer = (buffer << 5) | n;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            decoded.push((buffer >> bits) as u8);
        }
    }
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let step = (seconds / 30) as i64 + offset;
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&decoded).unwrap();
    mac.update(&(step as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let start = (digest[19] & 15) as usize;
    let n = u32::from_be_bytes(digest[start..start + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", n % 1_000_000)
}
#[sqlx::test(migrations = "../../migrations")]
async fn enrolled_totp_required_for_step_up_and_replay_rejected(db: sqlx::PgPool) {
    let password = "strong-pass-123";
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    let id: uuid::Uuid = sqlx::query_scalar("insert into users(email,role,password_hash,email_verified_at) values('totp-admin@example.test','admin',$1,now()) returning id").bind(hash).fetch_one(&db).await.unwrap();
    let (token, hash) = kernel::crypto::new_token();
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    )
    .bind(id)
    .bind(hash.as_slice())
    .execute(&db)
    .await
    .unwrap();
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let setup = call(
        auth::router(),
        &state,
        &token,
        "/mfa/totp/setup",
        json!({"currentPassword":password}),
    )
    .await;
    assert_eq!(setup.0, StatusCode::OK, "{}", setup.1);
    let secret = setup.1["data"]["secret"].as_str().unwrap();
    let enabled = call(
        auth::router(),
        &state,
        &token,
        "/mfa/totp/enable",
        json!({"code":totp(secret,-1)}),
    )
    .await;
    assert_eq!(enabled.0, StatusCode::OK, "{}", enabled.1);
    let recovery = enabled.1["data"]["recoveryCodes"][0].as_str().unwrap();
    let wrong = (0..1_000_000)
        .map(|n| format!("{n:06}"))
        .find(|candidate| !(-1..=1).any(|offset| totp(secret, offset) == *candidate))
        .unwrap();
    for body in [
        json!({"password":password,"code":wrong}),
        json!({"password":password}),
        json!({"password":password,"code":"bad"}),
        json!({"password":password,"code":"999999x"}),
        json!({"password":password,"code":recovery}),
        json!({"password":password,"recoveryCode":recovery}),
    ] {
        let result = call(admin::router(), &state, &token, "/step-up", body).await;
        assert!(result.0.is_client_error(), "{}", result.0);
    }
    sqlx::query("delete from rate_limits")
        .execute(&db)
        .await
        .unwrap();
    let code = totp(secret, 0);
    let result = call(
        admin::router(),
        &state,
        &token,
        "/step-up",
        json!({"password":password,"code":code}),
    )
    .await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    assert!(result.1["data"]["expiresAt"].is_string());
    let replay = call(
        admin::router(),
        &state,
        &token,
        "/step-up",
        json!({"password":password,"code":code}),
    )
    .await;
    assert_eq!(replay.0, StatusCode::UNAUTHORIZED);
    let used: i64 = sqlx::query_scalar(
        "select count(*) from mfa_recovery_codes where user_id=$1 and used_at is not null",
    )
    .bind(id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(used, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn opposing_admin_changes_are_bounded_and_self_actions_forbidden(db: sqlx::PgPool) {
    let state = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let mut admins = Vec::new();
    for email in ["admin-a@example.test", "admin-b@example.test"] {
        let id: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email,role,email_verified_at) values($1,'admin',now()) returning id",
        )
        .bind(email)
        .fetch_one(&db)
        .await
        .unwrap();
        let (token, hash) = kernel::crypto::new_token();
        let sid: uuid::Uuid = sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(id).bind(hash.as_slice()).fetch_one(&db).await.unwrap();
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(sid).execute(&db).await.unwrap();
        admins.push((id, token));
    }
    for (action, body) in [
        ("suspend", json!({})),
        ("unsuspend", json!({})),
        ("role", json!({"role":"user"})),
        ("mfa/reset", json!({})),
        ("delete", json!({})),
        ("restore", json!({})),
        ("sessions/revoke", json!({})),
    ] {
        let r = call(
            admin::router(),
            &state,
            &admins[0].1,
            &format!("/users/{}/{action}", admins[0].0),
            body,
        )
        .await;
        assert_eq!(r.0, StatusCode::FORBIDDEN, "{action}");
    }
    let path_a = format!("/users/{}/role", admins[1].0);
    let path_b = format!("/users/{}/role", admins[0].0);
    let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        tokio::join!(
            call(
                admin::router(),
                &state,
                &admins[0].1,
                &path_a,
                json!({"role":"user"})
            ),
            call(
                admin::router(),
                &state,
                &admins[1].1,
                &path_b,
                json!({"role":"user"})
            )
        )
    })
    .await
    .unwrap();
    assert!(a.0 == StatusCode::NO_CONTENT || b.0 == StatusCode::NO_CONTENT);
    assert_ne!(a.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(b.0, StatusCode::INTERNAL_SERVER_ERROR);
}
