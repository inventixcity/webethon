use axum::{
    Json, Router,
    extract::{FromRequest, Request, State},
    http::{StatusCode, header},
    routing::get,
};
use kernel::extract::Json as JsonBody;
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    request::RequestMeta,
    security::{AuditEntry, audit},
    session,
    viewer::Viewer,
};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new().route("/me", get(read).patch(update).delete(delete))
}
async fn read(State(state): State<AppState>, viewer: Viewer) -> AppResult<Json<Value>> {
    let row: (uuid::Uuid, String, String, Option<String>, String, time::OffsetDateTime) = sqlx::query_as("select id, email::text, display_name, avatar_url, role, created_at from users where id=$1 and deleted_at is null")
        .bind(viewer.id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    Ok(Json(
        json!({"data": {"id": row.0, "email": row.1, "displayName": row.2, "avatarUrl": row.3, "role": if viewer.is_admin() {"admin"} else {&row.4}, "createdAt": row.5.format(&time::format_description::well_known::Rfc3339).map_err(AppError::internal)?}}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    display_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    avatar_url: Option<Option<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteInput {
    current_password: String,
}
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":message}]))
}
fn guard_demo(state: &AppState, viewer: &Viewer) -> AppResult<()> {
    if state
        .config
        .demo_email
        .as_ref()
        .is_some_and(|email| email.eq_ignore_ascii_case(&viewer.email))
    {
        return Err(AppError::new(
            ErrorCode::Forbidden,
            "The demo account cannot be changed.",
        ));
    }
    Ok(())
}
async fn update(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    JsonBody(input): JsonBody<Input>,
) -> AppResult<Json<Value>> {
    guard_demo(&state, &viewer)?;
    let name = input.display_name.map(|name| name.trim().to_owned());
    if let Some(name) = &name
        && (name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control))
    {
        return Err(invalid(
            "displayName",
            "Use 1 to 120 characters without control characters.",
        ));
    }
    if let Some(Some(url)) = &input.avatar_url
        && (url.len() > 2048
            || reqwest::Url::parse(url)
                .ok()
                .filter(|url| url.scheme() == "https" && url.host_str().is_some())
                .is_none())
    {
        return Err(invalid("avatarUrl", "Use a valid HTTPS URL."));
    }
    let result = sqlx::query("update users set display_name=coalesce($2,display_name), avatar_url=case when $3 then $4 else avatar_url end where id=$1 and deleted_at is null")
        .bind(viewer.id).bind(name).bind(input.avatar_url.is_some()).bind(input.avatar_url.flatten()).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "profile.update",
            actor_id: Some(viewer.id),
            target_type: Some("user"),
            target_id: Some(viewer.id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    read(State(state), viewer).await
}
async fn delete(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    request: Request,
) -> AppResult<(
    StatusCode,
    [(header::HeaderName, axum::http::HeaderValue); 1],
)> {
    if viewer.is_admin() || viewer.is_examiner() {
        return Err(AppError::new(
            ErrorCode::Forbidden,
            "Administrators and examiners cannot delete their accounts here. Contact an administrator.",
        ));
    }
    guard_demo(&state, &viewer)?;
    let JsonBody(input) = JsonBody::<DeleteInput>::from_request(request, &state).await?;
    if !(1..=128).contains(&input.current_password.chars().count()) {
        return Err(invalid("currentPassword", "Enter your current password."));
    }
    let mut tx = state.db.begin().await?;
    let stored: Option<Option<String>> = sqlx::query_scalar(
        "select password_hash from users where id=$1 and deleted_at is null for update",
    )
    .bind(viewer.id)
    .fetch_optional(&mut *tx)
    .await?;
    let stored = stored.flatten().ok_or_else(AppError::not_found)?;
    let (valid, _) = auth::password::verify(&state, input.current_password, Some(stored)).await?;
    if !valid {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That password doesn't match this account.",
        ));
    }
    let active_attempt: bool = sqlx::query_scalar(
        "select exists(select 1 from attempts where candidate_id=$1 and not sandbox and status='in_progress')",
    )
    .bind(viewer.id)
    .fetch_one(&mut *tx)
    .await?;
    let open_dispute: bool = sqlx::query_scalar(
        "select exists(select 1 from disputes where candidate_id=$1 and status='open')",
    )
    .bind(viewer.id)
    .fetch_one(&mut *tx)
    .await?;
    if active_attempt || open_dispute {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Close your active exam attempt and resolve open disputes before deleting your account.",
        ));
    }
    let result =
        sqlx::query("update users set deleted_at=now() where id=$1 and deleted_at is null")
            .bind(viewer.id)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    sqlx::query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null")
        .bind(viewer.id)
        .execute(&mut *tx)
        .await?;
    kernel::security::audit_tx(
        &mut tx,
        &meta,
        AuditEntry {
            action: "account.delete",
            actor_id: Some(viewer.id),
            target_type: Some("user"),
            target_id: Some(viewer.id.to_string()),
            meta: json!({}),
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session::clear_cookie(&state.config))],
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod extractor_rejection_tests {
    use super::*;
    use axum::extract::FromRequest;
    #[tokio::test]
    async fn dto_rejections_use_shared_errors() {
        for (body, code, path) in [
            ("{", kernel::ErrorCode::BadRequest, ""),
            (
                "{\"unexpected\":1}",
                kernel::ErrorCode::ValidationFailed,
                "unexpected",
            ),
        ] {
            let request = axum::http::Request::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            let error = match <JsonBody<Input> as FromRequest<()>>::from_request(request, &()).await
            {
                Ok(_) => panic!("invalid input accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, code);
            if !path.is_empty() {
                assert_eq!(error.details.unwrap()[0]["path"], path);
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod deletion_tests {
    use super::*;
    use kernel::{config::Config, email::LogSender, viewer::Role};
    use std::sync::Arc;

    fn state(db: sqlx::PgPool) -> AppState {
        AppState {
            db,
            config: Arc::new(Config::from_env().expect("test config")),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }

    fn viewer(id: uuid::Uuid, role: Role) -> Viewer {
        Viewer {
            id,
            session_id: uuid::Uuid::new_v4(),
            email: "delete@example.test".into(),
            display_name: "Delete account".into(),
            role,
            via_cookie: false,
        }
    }

    fn meta() -> RequestMeta {
        RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: "account-delete-test".into(),
            request_id: "account-delete-test".into(),
        }
    }

    fn deletion_request(password: &str) -> Request {
        Request::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({"currentPassword":password}).to_string(),
            ))
            .expect("build deletion request")
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn delete_requires_password_and_commits_soft_delete_revocation_and_audit(
        db: sqlx::PgPool,
    ) {
        let state = state(db.clone());
        let hash = auth::password::hash(&state, "Candidate-password-938!".into())
            .await
            .expect("hash password");
        let user: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email,display_name,password_hash) values('delete@example.test','Delete account',$1) returning id",
        )
        .bind(hash)
        .fetch_one(&db)
        .await
        .expect("insert candidate");
        let session_id: uuid::Uuid = sqlx::query_scalar(
            "insert into sessions(user_id,token_hash,expires_at) values($1,digest('delete-session','sha256'),now()+interval '1 hour') returning id",
        )
        .bind(user)
        .fetch_one(&db)
        .await
        .expect("insert session");

        let denied = delete(
            State(state.clone()),
            viewer(user, Role::User),
            meta(),
            deletion_request("wrong-password"),
        )
        .await
        .expect_err("wrong password must be rejected");
        assert_eq!(denied.code, ErrorCode::InvalidCredentials);
        let deleted: Option<time::OffsetDateTime> =
            sqlx::query_scalar("select deleted_at from users where id=$1")
                .bind(user)
                .fetch_one(&db)
                .await
                .expect("read unchanged user");
        assert!(deleted.is_none());

        let denied = delete(
            State(state.clone()),
            viewer(user, Role::Admin),
            meta(),
            deletion_request("Candidate-password-938!"),
        )
        .await
        .expect_err("admins must use the privileged account flow");
        assert_eq!(denied.code, ErrorCode::Forbidden);

        let owner: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('delete-owner@example.test','examiner') returning id",
        )
        .fetch_one(&db)
        .await
        .expect("insert exam owner");
        let exam: uuid::Uuid = sqlx::query_scalar(
            "insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks,pass_marks) values($1,'Deletion guard',now()-interval '1 hour',now()+interval '1 hour',30,1,0) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .expect("insert exam");
        let item: uuid::Uuid = sqlx::query_scalar(
            "insert into exam_items(exam_id,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric) values($1,0,'guard',1,'single','Guard?','[]','[]',1,0,'all_or_nothing','') returning id",
        )
        .bind(exam)
        .fetch_one(&db)
        .await
        .expect("insert exam item");
        let attempt: uuid::Uuid = sqlx::query_scalar(
            "insert into attempts(exam_id,candidate_id,status,deadline_at,seed,item_order,journal_genesis) values($1,$2,'in_progress',now()+interval '1 hour',1,$3,$4) returning id",
        )
        .bind(exam)
        .bind(user)
        .bind(vec![item])
        .bind(vec![0_u8; 32])
        .fetch_one(&db)
        .await
        .expect("insert in-progress attempt");
        let denied = delete(
            State(state.clone()),
            viewer(user, Role::User),
            meta(),
            deletion_request("Candidate-password-938!"),
        )
        .await
        .expect_err("active attempt must block deletion");
        assert_eq!(denied.code, ErrorCode::Conflict);
        sqlx::query("update attempts set status='submitted' where id=$1")
            .bind(attempt)
            .execute(&db)
            .await
            .expect("submit fixture attempt");
        sqlx::query("insert into disputes(attempt_id,item_id,candidate_id,reason) values($1,$2,$3,'Please review this answer.')")
            .bind(attempt)
            .bind(item)
            .bind(user)
            .execute(&db)
            .await
            .expect("insert open dispute");
        let denied = delete(
            State(state.clone()),
            viewer(user, Role::User),
            meta(),
            deletion_request("Candidate-password-938!"),
        )
        .await
        .expect_err("open dispute must block deletion");
        assert_eq!(denied.code, ErrorCode::Conflict);
        sqlx::query("delete from disputes where attempt_id=$1")
            .bind(attempt)
            .execute(&db)
            .await
            .expect("close dispute fixture");

        let response = delete(
            State(state),
            viewer(user, Role::User),
            meta(),
            deletion_request("Candidate-password-938!"),
        )
        .await
        .expect("valid step-up deletion");
        assert_eq!(response.0, StatusCode::NO_CONTENT);
        let deleted: Option<time::OffsetDateTime> =
            sqlx::query_scalar("select deleted_at from users where id=$1")
                .bind(user)
                .fetch_one(&db)
                .await
                .expect("read deleted user");
        assert!(deleted.is_some());
        let revoked: bool =
            sqlx::query_scalar("select revoked_at is not null from sessions where id=$1")
                .bind(session_id)
                .fetch_one(&db)
                .await
                .expect("read revoked session");
        assert!(revoked);
        let audited: bool = sqlx::query_scalar(
            "select exists(select 1 from audit_log where action='account.delete' and target_id=$1)",
        )
        .bind(user.to_string())
        .fetch_one(&db)
        .await
        .expect("read atomic audit");
        assert!(audited);
    }
}
