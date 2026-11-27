#![allow(clippy::unwrap_used)]
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use kernel::{AppState, config::Config, email::LogSender};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    s: &AppState,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let catalog = payments::Catalog::parse(r#"{"products":[{"id":"pro-pass","name":"Pro pass","priceCents":4900,"currency":"usd","mode":"payment"}]}"#).unwrap();
    let response = admin::router_with_catalog(catalog)
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[sqlx::test(migrations = "../../migrations")]
async fn payment_admin_security_and_override(db: sqlx::PgPool) {
    let admin: Uuid = sqlx::query_scalar(
        "insert into users(email,role) values('payment-admin@example.test','admin') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let user: Uuid = sqlx::query_scalar(
        "insert into users(email) values('payment-user@example.test') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let (token, hash) = kernel::crypto::new_token();
    let session: Uuid=sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(admin).bind(hash.as_slice()).fetch_one(&db).await.unwrap();
    let (other, hash) = kernel::crypto::new_token();
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    )
    .bind(user)
    .bind(hash.as_slice())
    .execute(&db)
    .await
    .unwrap();
    let s = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let grant = json!({"userId":user,"productId":"pro-pass","expiresAt":"2099-01-01T00:00:00Z"});
    for (method, path) in [
        ("GET", "/payments/purchases"),
        ("GET", "/payments/entitlements"),
        ("POST", "/payments/entitlements/grant"),
        ("POST", "/payments/entitlements/revoke"),
    ] {
        assert_eq!(
            call(&s, &other, method, path, grant.clone()).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            "/payments/entitlements/grant",
            grant.clone()
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    let revoke = json!({"userId":user,"productId":"pro-pass"});
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            "/payments/entitlements/revoke",
            revoke.clone()
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()-interval '1 minute',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            "/payments/entitlements/grant",
            grant.clone()
        )
        .await
        .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        call(&s, &token, "POST", "/payments/entitlements/revoke", revoke)
            .await
            .0,
        StatusCode::PRECONDITION_REQUIRED
    );
    sqlx::query(
        "update admin_step_up set expires_at=now()+interval '10 minutes' where session_id=$1",
    )
    .bind(session)
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            "/payments/entitlements/grant",
            json!({"userId":user,"productId":"unknown"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&s, &token, "POST", "/payments/entitlements/grant", grant)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let audits: i64=sqlx::query_scalar("select count(*) from audit_log where action='admin.entitlement.grant' and meta ? 'before' and meta ? 'after'").fetch_one(&db).await.unwrap();
    assert_eq!(audits, 1);
    // This is the webhook conflict-update shape: Stripe updates its own fields only.
    sqlx::query("insert into entitlements(user_id,product_id,status,synced_at) values($1,'pro-pass','past_due',now()) on conflict(user_id,product_id) do update set status=excluded.status,synced_at=excluded.synced_at").bind(user).execute(&db).await.unwrap();
    let override_status: String = sqlx::query_scalar(
        "select admin_override_status from entitlements where user_id=$1 and product_id='pro-pass'",
    )
    .bind(user)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(override_status, "active");
    let (_, detail) = call(&s, &token, "GET", &format!("/users/{user}"), Value::Null).await;
    assert_eq!(detail["data"]["entitlements"][0]["status"], "active");
    assert!(
        payments::has_entitlement(&db, user, "pro-pass")
            .await
            .unwrap()
    );
    sqlx::query("update entitlements set admin_override_expires_at=now()-interval '1 second' where user_id=$1").bind(user).execute(&db).await.unwrap();
    let (_, detail) = call(&s, &token, "GET", &format!("/users/{user}"), Value::Null).await;
    assert_eq!(detail["data"]["entitlements"][0]["status"], "expired");
    assert!(
        !payments::has_entitlement(&db, user, "pro-pass")
            .await
            .unwrap()
    );
    let (_, list) = call(
        &s,
        &token,
        "GET",
        "/payments/entitlements?status=expired",
        Value::Null,
    )
    .await;
    assert_eq!(list["data"][0]["status"], "expired");
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            "/payments/entitlements/revoke",
            json!({"userId":user,"productId":"pro-pass"})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    sqlx::query("insert into purchases(user_id,product_id,stripe_object_id,amount_cents,currency) values($1,'pro-pass','cs_test_1',100,'usd'),($1,'pro-pass','cs_test_2',100,'usd')").bind(user).execute(&db).await.unwrap();
    let (_, first) = call(
        &s,
        &token,
        "GET",
        "/payments/purchases?limit=1",
        Value::Null,
    )
    .await;
    let next = first["meta"]["nextCursor"].as_str().unwrap();
    let (_, second) = call(
        &s,
        &token,
        "GET",
        &format!("/payments/purchases?limit=1&cursor={next}"),
        Value::Null,
    )
    .await;
    assert_ne!(first["data"][0]["id"], second["data"][0]["id"]);
    assert!(second["meta"]["nextCursor"].is_null());
}
