#![allow(clippy::unwrap_used)]
use argon2::{
    Argon2, PasswordHasher,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use hmac::{Hmac, Mac};
use kernel::{
    AppState,
    config::{Config, Environment},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
const PASSWORD: &str = "strong-pass-123";
const EMAIL: &str = "mfa@example.com";

async fn call(
    s: &AppState,
    method: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value, HeaderMap) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = auth::router_with_self_service()
        .with_state(s.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
    )
}
async fn seed(db: PgPool) -> (AppState, Uuid, String) {
    let mut config = Config::from_env().unwrap();
    config.breach_check = false;
    config.demo_email = None;
    config.demo_password = Some(PASSWORD.to_owned().into());
    config.email_from = "Test Kit <hello@example.com>".into();
    let s = AppState {
        db,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(kernel::email::LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let hash = Argon2::default()
        .hash_password(PASSWORD.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    let id=sqlx::query_scalar("insert into users(email,display_name,password_hash,email_verified_at) values($1,'MFA Test',$2,now()) returning id").bind(EMAIL).bind(hash).fetch_one(&s.db).await.unwrap();
    let r = call(
        &s,
        "POST",
        "/signin",
        json!({"email":EMAIL,"password":PASSWORD}),
        None,
    )
    .await;
    assert_eq!(r.0, StatusCode::OK, "{}", r.1);
    assert_eq!(r.1["data"]["user"]["mfaEnabled"], false);
    let token = r.1["data"]["token"].as_str().unwrap().to_owned();
    (s, id, token)
}
fn code(secret: &str, offset: i64) -> String {
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
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let step = (time / 30) as i64 + offset;
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&decoded).unwrap();
    mac.update(&(step as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let start = (digest[19] & 15) as usize;
    let n = u32::from_be_bytes(digest[start..start + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", n % 1_000_000)
}
async fn enroll(s: &AppState, token: &str) -> (String, Vec<String>) {
    let r = call(
        s,
        "POST",
        "/mfa/totp/setup",
        json!({"currentPassword":PASSWORD}),
        Some(token),
    )
    .await;
    assert_eq!(r.0, StatusCode::OK, "{}", r.1);
    let secret = r.1["data"]["secret"].as_str().unwrap().to_owned();
    let url = reqwest::Url::parse(r.1["data"]["otpauthUrl"].as_str().unwrap()).unwrap();
    assert_eq!(url.scheme(), "otpauth");
    assert_eq!(url.host_str(), Some("totp"));
    assert!(!url.path().starts_with("//"));
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(pairs["issuer"], "Test Kit");
    assert_eq!(pairs["secret"], secret);
    let svg = r.1["data"]["qrSvg"].as_str().unwrap();
    assert!(svg.contains("<svg"));
    assert!(!svg.contains("script"));
    let mut r = call(
        s,
        "POST",
        "/mfa/totp/enable",
        json!({"code":code(&secret,-1)}),
        Some(token),
    )
    .await;
    // A request delayed across a TOTP boundary may need a freshly generated code.
    if r.1["error"]["code"] == "INVALID_CODE" {
        r = call(
            s,
            "POST",
            "/mfa/totp/enable",
            json!({"code":code(&secret,-1)}),
            Some(token),
        )
        .await;
    }
    assert_eq!(r.0, StatusCode::OK, "{}", r.1);
    let codes: Vec<String> = serde_json::from_value(r.1["data"]["recoveryCodes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    assert!(codes.iter().all(|c| c.len() == 14));
    (secret, codes)
}
async fn challenge(s: &AppState) -> String {
    let r = call(
        s,
        "POST",
        "/signin",
        json!({"email":EMAIL,"password":PASSWORD}),
        None,
    )
    .await;
    assert_eq!(r.1["error"]["code"], "MFA_REQUIRED", "{}", r.1);
    assert_eq!(r.0, StatusCode::FORBIDDEN);
    assert!(!r.2.contains_key("set-cookie"));
    r.1["error"]["details"]["mfaToken"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn verify(
    s: &AppState,
    t: &str,
    code: &str,
    recovery: bool,
) -> (StatusCode, Value, HeaderMap) {
    let body = if recovery {
        json!({"mfaToken":t,"recoveryCode":code})
    } else {
        json!({"mfaToken":t,"code":code})
    };
    call(s, "POST", "/mfa/verify", body, None).await
}
async fn session_count(s: &AppState) -> i64 {
    sqlx::query_scalar("select count(*) from sessions where revoked_at is null")
        .fetch_one(&s.db)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrollment_signin_session_and_totp_replay(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let other = call(
        &s,
        "POST",
        "/signin",
        json!({"email":EMAIL,"password":PASSWORD}),
        None,
    )
    .await
    .1["data"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let (secret, _) = enroll(&s, &token).await;
    assert_eq!(session_count(&s).await, 1);
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(&other)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let status = call(&s, "GET", "/mfa", json!({}), Some(&token)).await;
    assert_eq!(
        status.1["data"],
        json!({"totpEnabled":true,"recoveryCodesRemaining":10})
    );
    let c = challenge(&s).await;
    assert_eq!(session_count(&s).await, 1);
    let pin = code(&secret, 0);
    let r = verify(&s, &c, &pin, false).await;
    assert_eq!(r.0, StatusCode::OK, "{}", r.1);
    assert!(r.2.contains_key("set-cookie"));
    assert_eq!(r.1["data"]["user"]["mfaEnabled"], true);
    let current = call(
        &s,
        "GET",
        "/session",
        json!({}),
        r.1["data"]["token"].as_str(),
    )
    .await;
    assert_eq!(current.1["data"]["user"]["mfaEnabled"], true);
    assert_eq!(
        verify(&s, &c, &pin, false).await.1["error"]["code"],
        "INVALID_CODE"
    );
    let c = challenge(&s).await;
    assert_eq!(
        verify(&s, &c, &pin, false).await.1["error"]["code"],
        "INVALID_CODE"
    );
    assert_eq!(session_count(&s).await, 2);
}
#[sqlx::test(migrations = "../../migrations")]
async fn attempts_durable_sixth_rejected_and_fifth_allowed(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    for n in 1..=5 {
        assert_eq!(
            verify(&s, &c, "!!!!!!", false).await.1["error"]["code"],
            "INVALID_CODE"
        );
        let attempts: i32 =
            sqlx::query_scalar("select attempts from mfa_challenges where token_hash=$1")
                .bind(kernel::crypto::hash_token(&c).unwrap().as_slice())
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(attempts, n);
    }
    assert_eq!(
        verify(&s, &c, &codes[0], true).await.1["error"]["code"],
        "INVALID_CODE"
    );
    assert_eq!(session_count(&s).await, 1);
    let c = challenge(&s).await;
    for _ in 0..4 {
        assert_eq!(
            verify(&s, &c, "!!!!!!", false).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(verify(&s, &c, &codes[0], true).await.0, StatusCode::OK);
}
#[sqlx::test(migrations = "../../migrations")]
async fn expired_challenge_and_inactive_accounts_fail(db: PgPool) {
    let (s, id, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    sqlx::query("update mfa_challenges set expires_at=now()-interval '1 second'")
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        verify(&s, &c, &codes[0], true).await.1["error"]["code"],
        "INVALID_CODE"
    );
    let c = challenge(&s).await;
    sqlx::query("update users set status='suspended' where id=$1")
        .bind(id)
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        verify(&s, &c, &codes[0], true).await.0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("update users set status='active',deleted_at=now() where id=$1")
        .bind(id)
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        verify(&s, &c, &codes[0], true).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(session_count(&s).await, 1);
    let count: i64 =
        sqlx::query_scalar("select count(*) from mfa_recovery_codes where used_at is not null")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
#[sqlx::test(migrations = "../../migrations")]
async fn recovery_single_use_across_concurrent_challenges(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let a = challenge(&s).await;
    let b = challenge(&s).await;
    let (a, b) = tokio::join!(
        verify(&s, &a, &codes[0], true),
        verify(&s, &b, &codes[0], true)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401]);
    assert_eq!(session_count(&s).await, 2);
    let c = challenge(&s).await;
    assert_eq!(
        verify(&s, &c, &codes[0], true).await.1["error"]["code"],
        "INVALID_CODE"
    );
    let r = call(&s, "GET", "/mfa", json!({}), Some(&token)).await;
    assert_eq!(r.1["data"]["recoveryCodesRemaining"], 9);
}
#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_challenge_consumption_uses_only_one_factor(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    let (a, b) = tokio::join!(
        verify(&s, &c, &codes[0], true),
        verify(&s, &c, &codes[1], true)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401]);
    let used: i64 =
        sqlx::query_scalar("select count(*) from mfa_recovery_codes where used_at is not null")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(used, 1);
    assert_eq!(session_count(&s).await, 2);
}
#[sqlx::test(migrations = "../../migrations")]
async fn disable_needs_password_and_factor(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    let r = call(
        &s,
        "POST",
        "/mfa/totp/disable",
        json!({"currentPassword":"wrong","code":codes[0]}),
        Some(&token),
    )
    .await;
    assert_eq!(r.1["error"]["code"], "INVALID_CREDENTIALS");
    let r = call(
        &s,
        "POST",
        "/mfa/totp/disable",
        json!({"currentPassword":PASSWORD,"code":"not-a-code"}),
        Some(&token),
    )
    .await;
    assert_eq!(r.1["error"]["code"], "INVALID_CODE");
    let other = verify(&s, &c, &codes[1], true).await.1["data"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let c = challenge(&s).await;
    let r = call(
        &s,
        "POST",
        "/mfa/totp/disable",
        json!({"currentPassword":PASSWORD,"code":codes[0]}),
        Some(&token),
    )
    .await;
    assert_eq!(r.0, StatusCode::NO_CONTENT, "{}", r.1);
    assert_eq!(
        verify(&s, &c, &codes[2], true).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&s, "GET", "/session", json!({}), Some(&other)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let status = call(&s, "GET", "/mfa", json!({}), Some(&token)).await;
    assert_eq!(
        status.1["data"],
        json!({"totpEnabled":false,"recoveryCodesRemaining":0})
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/signin",
            json!({"email":EMAIL,"password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn reset_and_demo_require_mfa_without_session_cookie(db: PgPool) {
    let (mut s, id, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    Arc::make_mut(&mut s.config).demo_email = Some(EMAIL.into());
    let r = call(&s, "POST", "/demo", json!({}), None).await;
    assert_eq!(r.1["error"]["code"], "MFA_REQUIRED");
    Arc::make_mut(&mut s.config).demo_email = None;
    assert!(!r.2.contains_key("set-cookie"));
    let (grant, hash) = kernel::crypto::new_token();
    sqlx::query("insert into reset_grants(token_hash,user_id,expires_at) values($1,$2,now()+interval '5 minutes')").bind(hash.as_slice()).bind(id).execute(&s.db).await.unwrap();
    let r = call(
        &s,
        "POST",
        "/password/reset",
        json!({"resetToken":grant,"password":"new-strong-pass-456"}),
        None,
    )
    .await;
    assert_eq!(r.1["error"]["code"], "MFA_REQUIRED", "{}", r.1);
    let cookies: Vec<_> =
        r.2.get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
    assert_eq!(cookies.len(), 1);
    assert!(cookies[0].starts_with("reset=;"));
    assert!(cookies[0].contains("Max-Age=0"));
    assert_eq!(session_count(&s).await, 0);
    let challenge = r.1["error"]["details"]["mfaToken"].as_str().unwrap();
    assert_eq!(
        verify(&s, challenge, &codes[0], true).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/signin",
            json!({"email":EMAIL,"password":PASSWORD}),
            None
        )
        .await
        .1["error"]["code"],
        "INVALID_CREDENTIALS"
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/signin",
            json!({"email":EMAIL,"password":"new-strong-pass-456"}),
            None
        )
        .await
        .1["error"]["code"],
        "MFA_REQUIRED"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn production_missing_key_fails_closed(db: PgPool) {
    assert!(
        std::env::var("MFA_ENCRYPTION_KEY").is_err(),
        "Run this test without MFA_ENCRYPTION_KEY"
    );
    let (mut s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    Arc::make_mut(&mut s.config).demo_email = Some(EMAIL.into());
    Arc::make_mut(&mut s.config).environment = Environment::Production;
    for (method, path, body, bearer) in [
        (
            "POST",
            "/mfa/totp/setup",
            json!({"currentPassword":PASSWORD}),
            Some(token.as_str()),
        ),
        (
            "POST",
            "/mfa/totp/enable",
            json!({"code":"123456"}),
            Some(token.as_str()),
        ),
        (
            "POST",
            "/mfa/totp/disable",
            json!({"currentPassword":PASSWORD,"code":codes[0]}),
            Some(token.as_str()),
        ),
        (
            "POST",
            "/mfa/recovery-codes",
            json!({"currentPassword":PASSWORD,"code":codes[0]}),
            Some(token.as_str()),
        ),
        ("GET", "/mfa", json!({}), Some(token.as_str())),
        (
            "POST",
            "/mfa/verify",
            json!({"mfaToken":c,"recoveryCode":codes[0]}),
            None,
        ),
        (
            "POST",
            "/signin",
            json!({"email":EMAIL,"password":PASSWORD}),
            None,
        ),
        ("POST", "/demo", json!({}), None),
    ] {
        let r = call(&s, method, path, body, bearer).await;
        assert_eq!(r.1["error"]["code"], "NOT_CONFIGURED", "{path}: {}", r.1);
        assert!(!r.2.contains_key("set-cookie"));
    }
    assert_eq!(session_count(&s).await, 1);
}
#[sqlx::test(migrations = "../../migrations")]
async fn regeneration_invalidates_old_codes_and_challenges(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let old = challenge(&s).await;
    let r = call(
        &s,
        "POST",
        "/mfa/recovery-codes",
        json!({"currentPassword":PASSWORD,"code":codes[0]}),
        Some(&token),
    )
    .await;
    assert_eq!(r.0, StatusCode::OK, "{}", r.1);
    assert_eq!(r.1["data"]["recoveryCodes"].as_array().unwrap().len(), 10);
    assert_eq!(
        verify(&s, &old, &codes[1], true).await.0,
        StatusCode::UNAUTHORIZED
    );
    let c = challenge(&s).await;
    assert_eq!(
        verify(&s, &c, &codes[1], true).await.0,
        StatusCode::UNAUTHORIZED
    );
    let new = r.1["data"]["recoveryCodes"][0]
        .as_str()
        .unwrap()
        .to_ascii_uppercase()
        .replace('-', " ");
    assert_eq!(verify(&s, &c, &new, true).await.0, StatusCode::OK);
}
#[sqlx::test(migrations = "../../migrations")]
async fn enable_attempts_and_management_are_rate_limited(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let setup = call(
        &s,
        "POST",
        "/mfa/totp/setup",
        json!({"currentPassword":PASSWORD}),
        Some(&token),
    )
    .await;
    assert_eq!(setup.0, StatusCode::OK);
    for _ in 0..5 {
        assert_eq!(
            call(
                &s,
                "POST",
                "/mfa/totp/enable",
                json!({"code":"!!!!!!"}),
                Some(&token)
            )
            .await
            .1["error"]["code"],
            "INVALID_CODE"
        );
    }
    let secret = setup.1["data"]["secret"].as_str().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            "/mfa/totp/enable",
            json!({"code":code(secret,0)}),
            Some(&token)
        )
        .await
        .1["error"]["code"],
        "RATE_LIMITED"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn verify_requires_exactly_one_factor_and_rejects_unknown_fields(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let c = challenge(&s).await;
    for body in [
        json!({"mfaToken":c}),
        json!({"mfaToken":c,"code":"123456","recoveryCode":codes[0]}),
        json!({"mfaToken":c,"recoveryCode":codes[0],"admin":true}),
        json!({"mfaToken":"x".repeat(129),"code":"123456"}),
    ] {
        assert_eq!(
            call(&s, "POST", "/mfa/verify", body, None).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(session_count(&s).await, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn disable_and_regenerate_cannot_consume_same_factor(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let body = json!({"currentPassword":PASSWORD,"code":codes[0]});
    let (disable, regenerate) = tokio::join!(
        call(&s, "POST", "/mfa/totp/disable", body.clone(), Some(&token)),
        call(&s, "POST", "/mfa/recovery-codes", body, Some(&token))
    );
    assert!(
        (disable.0 == StatusCode::NO_CONTENT && regenerate.0 == StatusCode::UNAUTHORIZED)
            || (regenerate.0 == StatusCode::OK && disable.0 == StatusCode::UNAUTHORIZED),
        "disable: {:?}; regenerate: {:?}",
        disable,
        regenerate
    );
    let status = call(&s, "GET", "/mfa", json!({}), Some(&token)).await;
    let expected = if disable.0 == StatusCode::NO_CONTENT {
        0
    } else {
        10
    };
    assert_eq!(status.1["data"]["recoveryCodesRemaining"], expected);
    assert_eq!(
        status.1["data"]["totpEnabled"],
        regenerate.0 == StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn session_failure_rolls_back_consumption_but_not_attempt(db: PgPool) {
    let (s, id, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let challenge = challenge(&s).await;
    sqlx::query("create function fail_mfa_session() returns trigger language plpgsql as $$ begin raise exception 'test session failure'; end $$").execute(&s.db).await.unwrap();
    sqlx::query("create trigger fail_mfa_session before insert on sessions for each row execute function fail_mfa_session()").execute(&s.db).await.unwrap();
    let result = verify(&s, &challenge, &codes[0], true).await;
    assert_eq!(result.1["error"]["code"], "INTERNAL");
    assert!(!result.2.contains_key("set-cookie"));
    let (attempts, used): (i32, bool) = sqlx::query_as(
        "select attempts,used_at is not null from mfa_challenges where token_hash=$1",
    )
    .bind(kernel::crypto::hash_token(&challenge).unwrap().as_slice())
    .fetch_one(&s.db)
    .await
    .unwrap();
    assert_eq!(attempts, 1);
    let hits: i32 = sqlx::query_scalar("select hits from rate_limits where key=translate(rtrim(encode(sha256(convert_to('mfa:verify:account:' || $1::text, 'UTF8')), 'base64'), '='), '+/', '-_')").bind(id).fetch_one(&s.db).await.unwrap();
    assert_eq!(hits, 1);
    assert!(!used);
    let used: i64 =
        sqlx::query_scalar("select count(*) from mfa_recovery_codes where used_at is not null")
            .fetch_one(&s.db)
            .await
            .unwrap();
    assert_eq!(used, 0);
    assert_eq!(session_count(&s).await, 1);
    sqlx::query("drop trigger fail_mfa_session on sessions")
        .execute(&s.db)
        .await
        .unwrap();
    assert_eq!(
        verify(&s, &challenge, &codes[0], true).await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn user_budget_spans_ips_and_challenges_and_ignores_expired(db: PgPool) {
    use axum::extract::ConnectInfo;
    let (mut s, id, token) = seed(db).await;
    Arc::make_mut(&mut s.config).ip_rate_limit_scale = 3;
    let (_, codes) = enroll(&s, &token).await;
    let mut challenges = Vec::new();
    for _ in 0..4 {
        let (raw, hash) = kernel::crypto::new_token();
        sqlx::query("insert into mfa_challenges(token_hash,user_id,expires_at) values($1,$2,now()+interval '5 minutes')").bind(hash.as_slice()).bind(id).execute(&s.db).await.unwrap();
        challenges.push(raw);
    }
    let expired_hash = kernel::crypto::hash_token(&challenges[3]).unwrap();
    sqlx::query(
        "update mfa_challenges set expires_at=now()-interval '1 second' where token_hash=$1",
    )
    .bind(expired_hash.as_slice())
    .execute(&s.db)
    .await
    .unwrap();
    assert_eq!(
        verify(&s, &challenges[3], "bad", true).await.0,
        StatusCode::UNAUTHORIZED
    );
    for i in 0..11 {
        let t = &challenges[usize::min(i / 5, 2)];
        let req = Request::builder()
            .method("POST")
            .uri("/mfa/verify")
            .header("content-type", "application/json")
            .extension(ConnectInfo(
                format!("192.0.2.{}:1234", i + 1)
                    .parse::<std::net::SocketAddr>()
                    .unwrap(),
            ))
            .body(Body::from(
                json!({"mfaToken":t,"recoveryCode":if i == 10 { &codes[0] } else { "wrong" }})
                    .to_string(),
            ))
            .unwrap();
        let res = auth::router_with_self_service()
            .with_state(s.clone())
            .oneshot(req)
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            if i == 10 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
        if i == 10 {
            assert!(res.headers().contains_key("retry-after"));
        }
    }
    let used: i64 = sqlx::query_scalar(
        "select count(*) from mfa_recovery_codes where user_id=$1 and used_at is not null",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .unwrap();
    assert_eq!(used, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn challenge_issuance_is_bounded(db: PgPool) {
    let (s, id, token) = seed(db).await;
    enroll(&s, &token).await;
    for _ in 0..6 {
        challenge(&s).await;
    }
    let live: i64 = sqlx::query_scalar("select count(*) from mfa_challenges where user_id=$1 and used_at is null and expires_at>now()")
        .bind(id).fetch_one(&s.db).await.unwrap();
    assert_eq!(live, 5);
}

#[sqlx::test(migrations = "../../migrations")]
async fn demo_identity_is_protected_without_erasing_factors(db: PgPool) {
    let (mut s, id, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    Arc::make_mut(&mut s.config).demo_email = Some(EMAIL.to_uppercase());
    let (grant, hash) = kernel::crypto::new_token();
    sqlx::query("insert into reset_grants(token_hash,user_id,expires_at) values($1,$2,now()+interval '5 minutes')").bind(hash.as_slice()).bind(id).execute(&s.db).await.unwrap();
    for (path, body) in [
        (
            "/password/change",
            json!({"currentPassword":PASSWORD,"newPassword":"new-strong-pass-456"}),
        ),
        (
            "/password/reset",
            json!({"resetToken":grant,"password":"new-strong-pass-456"}),
        ),
        ("/mfa/totp/setup", json!({"currentPassword":PASSWORD})),
        ("/mfa/totp/enable", json!({"code":"123456"})),
        (
            "/mfa/totp/disable",
            json!({"currentPassword":PASSWORD,"code":codes[0]}),
        ),
        (
            "/mfa/recovery-codes",
            json!({"currentPassword":PASSWORD,"code":codes[0]}),
        ),
        ("/signout-all", json!({})),
    ] {
        assert_eq!(
            call(&s, "POST", path, body, Some(&token)).await.0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    let factors: (bool, i64) = sqlx::query_as("select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null), (select count(*) from mfa_recovery_codes where user_id=$1 and used_at is null)").bind(id).fetch_one(&s.db).await.unwrap();
    assert_eq!(factors, (true, 10));
    assert_eq!(
        call(&s, "POST", "/signout", json!({}), Some(&token))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn signin_budget_is_cleared_only_after_factor_success(db: PgPool) {
    let (s, _, token) = seed(db).await;
    let (_, codes) = enroll(&s, &token).await;
    let challenge = challenge(&s).await;
    let key = format!("signin:acct:{EMAIL}");
    let encoded = {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        URL_SAFE_NO_PAD.encode(kernel::crypto::sha256(key.as_bytes()))
    };
    let hits: i32 = sqlx::query_scalar("select hits from rate_limits where key=$1")
        .bind(&encoded)
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(hits, 1);
    assert_eq!(
        verify(&s, &challenge, "wrong", true).await.0,
        StatusCode::UNAUTHORIZED
    );
    let hits: i32 = sqlx::query_scalar("select hits from rate_limits where key=$1")
        .bind(&encoded)
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(hits, 1);
    assert_eq!(
        verify(&s, &challenge, &codes[0], true).await.0,
        StatusCode::OK
    );
    let exists: bool = sqlx::query_scalar("select exists(select 1 from rate_limits where key=$1)")
        .bind(&encoded)
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert!(!exists);
}
