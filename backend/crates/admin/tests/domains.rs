#![allow(clippy::unwrap_used)]
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use kernel::{AppState, config::Config, email::LogSender};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn call(s: &AppState, token: &str, method: &str, path: &str, body: String) -> StatusCode {
    admin::router()
        .with_state(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
#[sqlx::test(migrations = "../../migrations")]
async fn domains_security_and_invariants(db: sqlx::PgPool) {
    let admin: Uuid = sqlx::query_scalar(
        "insert into users(email,role) values('domains-admin@example.test','admin') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let owner: Uuid = sqlx::query_scalar(
        "insert into users(email) values('domains-owner@example.test') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let target: Uuid = sqlx::query_scalar(
        "insert into users(email) values('domains-target@example.test') returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let (token, hash) = kernel::crypto::new_token();
    let session:Uuid=sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(admin).bind(hash.as_slice()).fetch_one(&db).await.unwrap();
    let (ordinary, hash) = kernel::crypto::new_token();
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",
    )
    .bind(owner)
    .bind(hash.as_slice())
    .execute(&db)
    .await
    .unwrap();
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Team','test-team',$1) returning id",
    )
    .bind(owner)
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query(
        "insert into team_members(team_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",
    )
    .bind(team)
    .bind(owner)
    .bind(target)
    .execute(&db)
    .await
    .unwrap();
    let resource:Uuid=sqlx::query_scalar("insert into booking_resources(owner_id,name,timezone,slot_minutes,capacity) values($1,'Room','UTC',30,1) returning id").bind(owner).fetch_one(&db).await.unwrap();
    let booking:Uuid=sqlx::query_scalar("insert into booking_bookings(resource_id,booker_id,starts_at,ends_at,seats,exclusive) values($1,$2,now()+interval '1 day',now()+interval '1 day 30 minutes',1,true) returning id").bind(resource).bind(owner).fetch_one(&db).await.unwrap();
    let s = AppState {
        db: db.clone(),
        config: Arc::new(Config::from_env().unwrap()),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let path = format!("/teams/{team}/transfer");
    let body = format!("{{\"userId\":\"{target}\"}}");
    assert_eq!(
        call(&s, &ordinary, "GET", "/teams", String::new()).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&s, &token, "POST", &path, body.clone()).await,
        StatusCode::PRECONDITION_REQUIRED
    );
    let cancel_path = format!("/bookings/{booking}/cancel");
    assert_eq!(
        call(&s, &token, "POST", &cancel_path, String::new()).await,
        StatusCode::PRECONDITION_REQUIRED
    );
    sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()-interval '1 minute',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
    assert_eq!(
        call(&s, &token, "POST", &path, body.clone()).await,
        StatusCode::PRECONDITION_REQUIRED
    );
    assert_eq!(
        call(&s, &token, "POST", &cancel_path, String::new()).await,
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
            &path,
            format!("{{\"userId\":\"{}\"}}", Uuid::new_v4())
        )
        .await,
        StatusCode::NOT_FOUND
    );
    let (a, b) = tokio::join!(
        call(&s, &token, "POST", &path, body),
        call(
            &s,
            &token,
            "POST",
            &path,
            format!("{{\"userId\":\"{owner}\"}}")
        )
    );
    assert_eq!(a, StatusCode::OK);
    assert_eq!(b, StatusCode::OK);
    let owners: i64 =
        sqlx::query_scalar("select count(*) from team_members where team_id=$1 and role='owner'")
            .bind(team)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(owners, 1);
    assert_eq!(
        call(
            &s,
            &token,
            "POST",
            &format!("/bookings/{booking}/cancel"),
            String::new()
        )
        .await,
        StatusCode::OK
    );
    let status: String = sqlx::query_scalar("select status from booking_bookings where id=$1")
        .bind(booking)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(status, "cancelled");
    let audits:i64=sqlx::query_scalar("select count(*) from audit_log where action in ('admin.team.transfer','admin.booking.cancel') and meta ? 'before' and meta ? 'after'").fetch_one(&db).await.unwrap();
    assert!(audits >= 2);
}
