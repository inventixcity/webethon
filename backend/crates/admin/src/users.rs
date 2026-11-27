use crate::{AdminViewer, JsonBody, audit, security as admin_security};
use axum::{Json, extract::State};
use kernel::extract::{Path, Query};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer,
    request::RequestMeta,
    security::{self, limits},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListQuery {
    q: Option<String>,
    role: Option<String>,
    status: Option<String>,
    verified: Option<bool>,
    mfa: Option<bool>,
    sort: Option<String>,
    limit: Option<i64>,
    cursor: Option<Uuid>,
}
fn invalid(path: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":"Invalid value."}]))
}
fn valid_provisioned_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&b))
        || domain.len() > 253
        || !domain.contains('.')
    {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}
pub(crate) async fn list(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    query: Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let Query(q) = query;
    let limit = q.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit"));
    }
    if q.q
        .as_ref()
        .is_some_and(|s| s.chars().count() > 254 || s.chars().any(char::is_control))
    {
        return Err(invalid("q"));
    }
    if q.role
        .as_deref()
        .is_some_and(|x| !["user", "candidate", "examiner", "admin"].contains(&x))
    {
        return Err(invalid("role"));
    }
    if q.status
        .as_deref()
        .is_some_and(|x| !["active", "suspended", "deleted"].contains(&x))
    {
        return Err(invalid("status"));
    }
    let sort = q.sort.as_deref().unwrap_or("newest");
    if !["newest", "oldest"].contains(&sort) {
        return Err(invalid("sort"));
    }
    if let Some(cursor) = q.cursor {
        let exists: bool = sqlx::query_scalar("select exists(select 1 from users where id=$1)")
            .bind(cursor)
            .fetch_one(&state.db)
            .await?;
        if !exists {
            return Err(invalid("cursor"));
        }
    }
    let rows: Vec<Value> = sqlx::query_scalar(r#"select jsonb_build_object('id',u.id,'email',u.email::text,'displayName',u.display_name,'role',case when u.role='admin' or lower(u.email::text)=any($9::text[]) then 'admin' when u.role='examiner' then 'examiner' else 'candidate' end,'storedRole',u.role,'status',u.status,'emailVerifiedAt',u.email_verified_at,'createdAt',u.created_at,'deletedAt',u.deleted_at,'mfa',exists(select 1 from mfa_totp m where m.user_id=u.id and m.enabled_at is not null)) from users u where ($1::text is null or position(lower($1) in lower(u.email::text))>0 or position(lower($1) in lower(u.display_name))>0) and ($2::text is null or (case when u.role='admin' or lower(u.email::text)=any($9::text[]) then 'admin' when u.role='examiner' then 'examiner' else 'candidate' end)=$2) and ($3::text is null or case when $3='deleted' then u.deleted_at is not null else u.deleted_at is null and u.status=$3 end) and ($4::boolean is null or (u.email_verified_at is not null)=$4) and ($5::boolean is null or exists(select 1 from mfa_totp m where m.user_id=u.id and m.enabled_at is not null)=$5) and ($6::uuid is null or case when $7='newest' then (u.created_at,u.id)<(select created_at,id from users where id=$6) else (u.created_at,u.id)>(select created_at,id from users where id=$6) end) order by case when $7='newest' then u.created_at end desc,case when $7='newest' then u.id end desc,case when $7='oldest' then u.created_at end asc,case when $7='oldest' then u.id end asc limit $8"#).bind(q.q).bind(q.role.as_deref().map(|r| if r == "user" { "candidate" } else { r })).bind(q.status).bind(q.verified).bind(q.mfa).bind(q.cursor).bind(sort).bind(limit+1).bind(state.config.admin_emails.iter().cloned().collect::<Vec<_>>()).fetch_all(&state.db).await?;
    let more = rows.len() > limit as usize;
    let mut rows = rows;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().and_then(|v| v.get("id")).cloned()
    } else {
        None
    };
    Ok(Json(json!({"data":rows,"meta":{"nextCursor":next}})))
}
pub(crate) async fn detail(
    State(state): State<AppState>,
    AdminViewer(_): AdminViewer,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let data: Option<Value> = sqlx::query_scalar(r#"select jsonb_build_object('user',jsonb_build_object('id',u.id,'email',u.email::text,'displayName',u.display_name,'avatarUrl',u.avatar_url,'role',case when u.role='admin' or lower(u.email::text)=any($2::text[]) then 'admin' when u.role='examiner' then 'examiner' else 'candidate' end,'storedRole',u.role,'status',u.status,'emailVerifiedAt',u.email_verified_at,'createdAt',u.created_at,'updatedAt',u.updated_at,'deletedAt',u.deleted_at,'mfa',exists(select 1 from mfa_totp where user_id=u.id and enabled_at is not null)), 'sessions',coalesce((select jsonb_agg(x) from (select id,created_at as "createdAt",last_seen_at as "lastSeenAt",expires_at as "expiresAt",revoked_at as "revokedAt",ip,user_agent as "userAgent" from sessions where user_id=u.id order by created_at desc limit 50) x),'[]'::jsonb), 'audit',coalesce((select jsonb_agg(x) from (select id,at,action,target_type as "targetType",target_id as "targetId" from audit_log where actor_id=u.id or (target_type='user' and target_id=u.id::text) order by id desc limit 50) x),'[]'::jsonb), 'teams',coalesce((select jsonb_agg(x) from (select t.id,t.name,t.slug,m.role from team_members m join teams t on t.id=m.team_id where m.user_id=u.id and t.deleted_at is null order by t.id limit 50) x),'[]'::jsonb), 'files',coalesce((select jsonb_agg(x) from (select id,original_name as "originalName",content_type as "contentType",size_bytes as "sizeBytes",created_at as "createdAt",deleted_at as "deletedAt" from files where owner_id=u.id order by created_at desc limit 50) x),'[]'::jsonb), 'entitlements',coalesce((select jsonb_agg(x) from (select product_id as "productId",case when admin_override_status='active' and admin_override_expires_at <= now() then 'expired' else coalesce(admin_override_status,status) end as status,case when admin_override_status is not null then admin_override_expires_at else current_period_end end as "currentPeriodEnd" from entitlements where user_id=u.id order by product_id limit 50) x),'[]'::jsonb)) from users u where u.id=$1"#).bind(id).bind(state.config.admin_emails.iter().cloned().collect::<Vec<_>>()).fetch_optional(&state.db).await?;
    Ok(Json(json!({"data":data.ok_or_else(AppError::not_found)?})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RoleInput {
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateInput {
    email: String,
    display_name: String,
    role: String,
}

pub(crate) async fn create(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    JsonBody(input): JsonBody<CreateInput>,
) -> AppResult<Json<Value>> {
    let email = input.email.trim().to_ascii_lowercase();
    let display = input.display_name.trim();
    let role = if input.role == "candidate" {
        "user"
    } else {
        input.role.as_str()
    };
    if email.len() > 254 || !valid_provisioned_email(&email) {
        return Err(invalid("email"));
    }
    if !(1..=120).contains(&display.chars().count()) || display.chars().any(char::is_control) {
        return Err(invalid("displayName"));
    }
    if !["user", "examiner"].contains(&role) {
        return Err(invalid("role"));
    }
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:users:create:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:users:create:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let (token, hash) = kernel::crypto::new_token();
    let mut tx = state.db.begin().await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    let id:Uuid=sqlx::query_scalar("insert into users(email,display_name,role) values($1,$2,$3) on conflict(email) do nothing returning id").bind(&email).bind(display).bind(role).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::new(ErrorCode::Conflict,"An account with this email already exists."))?;
    sqlx::query("insert into account_invites(token_hash,user_id,invited_by,expires_at) values($1,$2,$3,now()+interval '7 days')").bind(hash.as_slice()).bind(id).bind(viewer.id).execute(&mut *tx).await?;
    let link = format!("{}/invite/{}", state.config.app_origin, token);
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        "admin.user.create",
        ("user", &id.to_string()),
        json!({}),
        json!({"id":id,"email":email,"role":role}),
    )
    .await?;
    tx.commit().await?;
    let msg = kernel::email::Email {
        to: email.clone(),
        subject: "You are invited to Inventix Invigil".into(),
        html: format!(
            "<p>Your Invigil account is ready.</p><p><a href=\"{link}\">Set your password</a></p>"
        ),
        text: format!("Set your Invigil password: {link}"),
    };
    if let Err(error) = state.email.send(&msg).await {
        tracing::warn!(error=%error,"admin invite email delivery failed");
    }
    Ok(Json(
        json!({"data":{"id":id,"email":email,"displayName":display,"role":if role=="user"{"candidate"}else{role},"inviteLink":link}}),
    ))
}
pub(crate) async fn role(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    Path(id): Path<Uuid>,
    JsonBody(input): JsonBody<RoleInput>,
) -> AppResult<axum::http::StatusCode> {
    if !["user", "candidate", "examiner", "admin"].contains(&input.role.as_str()) {
        return Err(invalid("role"));
    }
    let role = if input.role == "candidate" {
        "user".to_owned()
    } else {
        input.role
    };
    mutate(state, meta, viewer, id, "role", Some(role)).await
}
macro_rules! action {
    ($name:ident,$action:literal) => {
        pub(crate) async fn $name(
            State(state): State<AppState>,
            meta: RequestMeta,
            AdminViewer(viewer): AdminViewer,
            Path(id): Path<Uuid>,
        ) -> AppResult<axum::http::StatusCode> {
            mutate(state, meta, viewer, id, $action, None).await
        }
    };
}
action!(suspend, "suspend");
action!(unsuspend, "unsuspend");
action!(revoke, "revoke");
action!(reset_mfa, "mfa_reset");
action!(delete, "delete");
action!(restore, "restore");
async fn mutate(
    state: AppState,
    meta: RequestMeta,
    viewer: Viewer,
    id: Uuid,
    action: &str,
    role: Option<String>,
) -> AppResult<axum::http::StatusCode> {
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:users:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:users:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    admin_security::reject_self(&viewer, id)?;
    let mut tx = state.db.begin().await?;
    admin_security::lock_users_in_order(&mut tx, viewer.id, id).await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    let before:Option<Value>=sqlx::query_scalar("select jsonb_build_object('id',id,'email',email::text,'role',role,'status',status,'deletedAt',deleted_at,'emailVerifiedAt',email_verified_at,'mfa',exists(select 1 from mfa_totp where user_id=users.id and enabled_at is not null)) from users where id=$1 for update").bind(id).fetch_optional(&mut *tx).await?;
    let before = before.ok_or_else(AppError::not_found)?;
    if action == "role" && role.as_deref() == Some("admin") && before["emailVerifiedAt"].is_null() {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Please verify this email before granting administrator access.",
        ));
    }
    if action == "role"
        && role.as_deref().is_some_and(|value| value != "admin")
        && before["email"]
            .as_str()
            .is_some_and(|e| state.config.admin_emails.contains(&e.to_ascii_lowercase()))
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "This administrator is configured by the server.",
        ));
    }
    if action == "role"
        && role.as_deref().is_some_and(|r| r != "admin")
        && before["role"] == "admin"
    {
        sqlx::query("select pg_advisory_xact_lock(hashtext('invigil-admin-role-change'))")
            .execute(&mut *tx)
            .await?;
        let remaining:i64=sqlx::query_scalar("select count(*) from users where role='admin' and status='active' and deleted_at is null and id<>$1")
            .bind(id).fetch_one(&mut *tx).await?;
        if remaining == 0 {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "The last active administrator cannot be demoted.",
            ));
        }
    }
    match action {
        "suspend" => {
            sqlx::query("update users set status='suspended' where id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        "unsuspend" => {
            sqlx::query("update users set status='active' where id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        "delete" => {
            sqlx::query("update users set deleted_at=coalesce(deleted_at,now()) where id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        "restore" => {
            sqlx::query("update users set deleted_at=null where id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        "role" => {
            sqlx::query("update users set role=$2 where id=$1")
                .bind(id)
                .bind(role)
                .execute(&mut *tx)
                .await?;
        }
        "mfa_reset" => {
            for table in [
                "delete from mfa_challenges where user_id=$1",
                "delete from mfa_recovery_codes where user_id=$1",
                "delete from mfa_totp where user_id=$1",
            ] {
                sqlx::query(table).bind(id).execute(&mut *tx).await?;
            }
        }
        _ => {}
    }
    if ["suspend", "delete", "revoke", "mfa_reset"].contains(&action) {
        sqlx::query("update sessions set revoked_at=coalesce(revoked_at,now()) where user_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from admin_step_up where session_id in (select id from sessions where user_id=$1)").bind(id).execute(&mut *tx).await?;
    }
    let after:Value=sqlx::query_scalar("select jsonb_build_object('id',id,'email',email::text,'role',role,'status',status,'deletedAt',deleted_at,'emailVerifiedAt',email_verified_at,'mfa',exists(select 1 from mfa_totp where user_id=users.id and enabled_at is not null)) from users where id=$1").bind(id).fetch_one(&mut *tx).await?;
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        &format!("admin.user.{action}"),
        ("user", &id.to_string()),
        before,
        after,
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
pub(crate) async fn resend(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    Path(id): Path<Uuid>,
) -> AppResult<axum::http::StatusCode> {
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:verification:ip:{}", meta.ip),
        limits::EMAIL_PER_IP,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:verification:user:{}", viewer.id),
        limits::EMAIL_PER_ACCOUNT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("admin:verification:target:{id}"),
        limits::EMAIL_PER_ACCOUNT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    admin_security::lock_users_in_order(&mut tx, viewer.id, id).await?;
    admin_security::require_step_up(&mut tx, &state, &viewer).await?;
    let row: Option<(String, bool)> = sqlx::query_as(
        "select email::text,email_verified_at is not null from users where id=$1 for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (email, verified) = row.ok_or_else(AppError::not_found)?;
    audit::audit_before_after(
        &mut tx,
        &meta,
        &viewer,
        "admin.user.verification_resend",
        ("user", &id.to_string()),
        json!({"verified":verified}),
        json!({"verified":verified}),
    )
    .await?;
    tx.commit().await?;
    if !verified {
        let encoded: String = email
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let link = format!("{}/signup?email={}", state.config.app_origin, encoded);
        let text = format!("Please restart your signup and choose a new password: {link}");
        state.email.send(&kernel::email::Email{to:email,subject:"Restart your signup".into(),html:format!("<p>Please restart your signup and choose a new password.</p><p><a href=\"{link}\">Continue signup</a></p>"),text}).await.map_err(AppError::internal)?;
    }
    Ok(axum::http::StatusCode::ACCEPTED)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use kernel::{config::Config, email::LogSender};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn provisioned_email_validation_rejects_malformed_domains() {
        for email in [
            "a..b@example.test",
            ".a@example.test",
            "a@-bad.example",
            "a@example..test",
            "a @example.test",
        ] {
            assert!(!valid_provisioned_email(email), "{email}");
        }
        assert!(valid_provisioned_email("name+tag@invigil.app"));
    }
    async fn request(
        state: &AppState,
        token: &str,
        method: &str,
        path: &str,
        body: &str,
    ) -> axum::response::Response {
        crate::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn configured_admin_has_effective_role_and_filters(db: sqlx::PgPool) {
        let id: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('configured@example.test','user') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("insert into users(email,display_name,role) values('examiner-visible@example.test','Examiner Visible','examiner'),('candidate-visible@example.test','Candidate Visible','user')")
            .execute(&db).await.unwrap();
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(id).bind(hash.as_slice()).execute(&db).await.unwrap();
        let mut config = Config::from_env().unwrap();
        config.admin_emails.clear();
        config.admin_emails.insert("configured@example.test".into());
        let state = AppState {
            db,
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        for (path, expected) in [
            ("/users?role=admin".to_owned(), true),
            ("/users?role=user".to_owned(), true),
        ] {
            let response = request(&state, &token, "GET", &path, "").await;
            let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            let rows = body["data"].as_array().unwrap();
            assert_eq!(!rows.is_empty(), expected);
            if path.ends_with("admin") {
                assert_eq!(rows[0]["role"], "admin");
                assert_eq!(rows[0]["storedRole"], "user");
            } else {
                assert!(
                    rows.iter()
                        .all(|row| row["role"] == "candidate" && row["storedRole"] == "user")
                );
            }
        }
        let response = request(&state, &token, "GET", &format!("/users/{id}"), "").await;
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["data"]["user"]["role"], "admin");
        assert_eq!(body["data"]["user"]["storedRole"], "user");
        let response = request(&state, &token, "GET", "/users?unexpected=secret", "").await;
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"]["message"],
            "Please check the highlighted fields."
        );
        assert_eq!(body["error"]["details"][0]["path"], "unexpected");
        assert_eq!(
            request(&state, &token, "GET", "/users/not-a-uuid", "")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        for (role, expected_role, stored_role) in [
            ("examiner", "examiner", "examiner"),
            ("candidate", "candidate", "user"),
            ("user", "candidate", "user"),
        ] {
            let response = request(&state, &token, "GET", &format!("/users?role={role}"), "").await;
            let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(
                body["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["role"] == expected_role && row["storedRole"] == stored_role)
            );
        }
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn users_routes_require_admin_and_mutations_require_stepup(db: sqlx::PgPool) {
        let admin:Uuid=sqlx::query_scalar("insert into users(email,role,email_verified_at) values('adm@example.test','admin',now()) returning id").fetch_one(&db).await.unwrap();
        let user:Uuid=sqlx::query_scalar("insert into users(email,password_hash) values('victim@example.test','sensitive-hash') returning id").fetch_one(&db).await.unwrap();
        let (token, hash) = kernel::crypto::new_token();
        let sid:Uuid=sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(admin).bind(hash.as_slice()).fetch_one(&db).await.unwrap();
        let (user_token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(user).bind(hash.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        for (method, path, body) in [
            ("GET", "/users".to_string(), ""),
            ("GET", format!("/users/{user}"), ""),
            ("POST", format!("/users/{user}/suspend"), ""),
            ("POST", format!("/users/{user}/unsuspend"), ""),
            ("POST", format!("/users/{user}/role"), r#"{"role":"user"}"#),
            ("POST", format!("/users/{user}/sessions/revoke"), ""),
            ("POST", format!("/users/{user}/mfa/reset"), ""),
            ("POST", format!("/users/{user}/delete"), ""),
            ("POST", format!("/users/{user}/restore"), ""),
            ("POST", format!("/users/{user}/verification/resend"), ""),
        ] {
            assert_eq!(
                request(&state, &user_token, method, &path, body)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            request(
                &state,
                &user_token,
                "POST",
                "/users",
                r#"{"email":"blocked@example.test","displayName":"Blocked","role":"candidate"}"#
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        for path in [
            "suspend",
            "unsuspend",
            "role",
            "sessions/revoke",
            "mfa/reset",
            "delete",
            "restore",
            "verification/resend",
        ] {
            let body = if path == "role" {
                r#"{"role":"user"}"#
            } else {
                ""
            };
            assert_eq!(
                request(
                    &state,
                    &token,
                    "POST",
                    &format!("/users/{user}/{path}"),
                    body
                )
                .await
                .status(),
                StatusCode::PRECONDITION_REQUIRED
            );
        }
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()-interval '1 minute',digest('','sha256'))").bind(sid).execute(&db).await.unwrap();
        for path in [
            "suspend",
            "unsuspend",
            "role",
            "sessions/revoke",
            "mfa/reset",
            "delete",
            "restore",
            "verification/resend",
        ] {
            let body = if path == "role" {
                r#"{"role":"user"}"#
            } else {
                ""
            };
            assert_eq!(
                request(
                    &state,
                    &token,
                    "POST",
                    &format!("/users/{user}/{path}"),
                    body
                )
                .await
                .status(),
                StatusCode::PRECONDITION_REQUIRED,
                "{path}"
            );
        }
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                "/users",
                r#"{"email":"stepup@example.test","displayName":"Step Up","role":"candidate"}"#
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        sqlx::query("delete from admin_step_up where session_id=$1")
            .bind(sid)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(sid).execute(&db).await.unwrap();
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                &format!("/users/{user}/role"),
                r#"{"role":"admin"}"#
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                &format!("/users/{admin}/suspend"),
                ""
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                &format!("/users/{user}/suspend"),
                ""
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        let response = request(&state, &token, "POST", "/users", r#"{"email":"new-candidate@example.test","displayName":"New Candidate","role":"candidate"}"#).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created["data"]["role"], "candidate");
        assert!(
            created["data"]["inviteLink"]
                .as_str()
                .is_some_and(|link| link.contains("/invite/"))
        );
        let stored: Option<String> =
            sqlx::query_scalar("select role from users where email='new-candidate@example.test'")
                .fetch_optional(&db)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some("user"));
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                &format!("/users/{user}/restore"),
                ""
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        let revoked: bool =
            sqlx::query_scalar("select revoked_at is not null from sessions where user_id=$1")
                .bind(user)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(revoked);
        let audits: Vec<Value> =
            sqlx::query_scalar("select meta from audit_log where target_id=$1 order by id")
                .bind(user.to_string())
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(audits.len(), 2);
        assert!(!json!(audits).to_string().contains("sensitive-hash"));
        assert_eq!(
            request(&state, &token, "GET", "/users?limit=0", "")
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                &state,
                &token,
                "GET",
                "/users?limit=1&q=%27%20OR%201%3D1--",
                ""
            )
            .await
            .status(),
            StatusCode::OK
        );
        let response = request(&state, &token, "GET", &format!("/users/{user}"), "").await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!body.contains("sensitive-hash"));
        assert!(!body.contains("token_hash"));
        sqlx::query(
            "update admin_step_up set expires_at=now()-interval '1 second' where session_id=$1",
        )
        .bind(sid)
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(
            request(
                &state,
                &token,
                "POST",
                &format!("/users/{user}/unsuspend"),
                ""
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
    }
}
