use crate::{codes, emails, password, validate};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer, crypto,
    extract::{Json as JsonBody, Path},
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    session,
};
use rand::{Rng, rngs::OsRng};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Signup {
    name: String,
    email: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    email: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeInput {
    email: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignupCode {
    email: String,
    code: String,
    signup_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resend {
    email: String,
    purpose: String,
    signup_token: Option<String>,
}
#[derive(sqlx::FromRow)]
struct User {
    id: Uuid,
    email: String,
    display_name: String,
    role: String,
    status: String,
    password_hash: Option<String>,
    verified: bool,
}
fn public(u: &User, state: &AppState) -> Value {
    json!({"id":u.id,"email":u.email,"displayName":u.display_name,"role":if state.config.admin_emails.contains(&u.email) { "admin" } else if u.role == "user" { "candidate" } else { &u.role },"mfaEnabled":false})
}
fn viewer_json(v: &Viewer) -> Value {
    json!({"id":v.id,"email":v.email,"displayName":v.display_name,"role":v.role.as_str()})
}
async fn find(state: &AppState, email: &str) -> AppResult<Option<User>> {
    Ok(sqlx::query_as("select id,email::text as email,display_name,role,status,password_hash,email_verified_at is not null as verified from users where email=$1 and deleted_at is null").bind(email).fetch_optional(&state.db).await?)
}
async fn rate(
    state: &AppState,
    action: &str,
    meta: &RequestMeta,
    email: &str,
    ip: security::Limit,
    acct: Option<security::Limit>,
) -> AppResult<()> {
    security::enforce_rate_limit(
        &state.db,
        &format!("{action}:ip:{}", meta.ip),
        state.config.scaled_ip_limit(ip),
    )
    .await?;
    if let Some(limit) = acct {
        security::enforce_rate_limit(&state.db, &format!("{action}:acct:{email}"), limit).await?;
    }
    Ok(())
}
pub(crate) fn guard_demo(state: &AppState, email: &str) -> AppResult<()> {
    if state
        .config
        .demo_email
        .as_deref()
        .is_some_and(|demo| demo.trim().eq_ignore_ascii_case(email))
    {
        return Err(AppError::new(
            ErrorCode::Forbidden,
            "This action is unavailable for the demo account.",
        ));
    }
    Ok(())
}
async fn audit(state: &AppState, meta: &RequestMeta, action: &str, id: Option<Uuid>) {
    security::audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: id,
            target_type: Some("user"),
            target_id: id.map(|v| v.to_string()),
            meta: json!({}),
        },
    )
    .await;
}
async fn mail_code(state: &AppState, email: &str, purpose: &str, cooldown: bool) -> AppResult<()> {
    if let Some(code) = codes::issue(state, email, purpose, cooldown).await? {
        emails::send(state, emails::code(state, email, &code));
    }
    Ok(())
}
fn accepted() -> Response {
    (
        StatusCode::ACCEPTED,
        Json(json!({"data":{"status":"verification_sent"}})),
    )
        .into_response()
}
async fn pad(start: tokio::time::Instant) {
    let millis = OsRng.gen_range(600..=800);
    tokio::time::sleep_until(start + std::time::Duration::from_millis(millis)).await;
}
async fn login_response(
    state: &AppState,
    meta: &RequestMeta,
    user: &User,
    upgrade: Option<String>,
) -> AppResult<Response> {
    let mut tx = state.db.begin().await?;
    let current: Option<(Option<String>, bool, bool)> = sqlx::query_as("select password_hash,email_verified_at is not null,status='active' and deleted_at is null from users where id=$1 for update")
        .bind(user.id).fetch_optional(&mut *tx).await?;
    let matches = match (&user.password_hash, current.as_ref()) {
        (Some(expected), Some((Some(actual), true, true))) => {
            crypto::constant_time_eq(expected.as_bytes(), actual.as_bytes())
        }
        _ => false,
    };
    if !matches {
        return Err(invalid_credentials());
    }
    if let Some(hash) = upgrade {
        sqlx::query("update users set password_hash=$1 where id=$2")
            .bind(hash)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    let login = crate::mfa::issue_locked(state, meta, user.id, &mut tx).await?;
    tx.commit().await?;
    let token = match login {
        crate::mfa::Login::Session(token) => token,
        crate::mfa::Login::Challenge(token) => return Err(crate::mfa::required(token)),
    };
    Ok((
        [(
            header::SET_COOKIE,
            session::cookie(&state.config, &token, state.config.session_ttl),
        )],
        Json(json!({"data":{"user":public(user,state),"token":token}})),
    )
        .into_response())
}
fn invalid_credentials() -> AppError {
    AppError::new(
        ErrorCode::InvalidCredentials,
        "That email and password don't match.",
    )
}
async fn signup(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<Signup>,
) -> AppResult<Response> {
    let start = tokio::time::Instant::now();
    let email = validate::email(&input.email)?;
    validate::length(&input.name, "name", 1, 120)?;
    // Local rules (no network) run before any budget: a typo on shared Wi-Fi must not use up
    // the IP's sign-up allowance for everyone else behind the same address.
    password::check_local(&email, &input.password)?;
    rate(
        &state,
        "signup",
        &meta,
        &email,
        limits::SIGN_UP_PER_IP,
        None,
    )
    .await?;
    rate(
        &state,
        "email",
        &meta,
        &email,
        limits::EMAIL_PER_IP,
        Some(limits::EMAIL_PER_ACCOUNT),
    )
    .await?;
    // The breach check makes an outbound call, so it waits until the budgets are spent.
    password::breach_check(&state, &input.password).await?;
    let hashed = password::hash(&state, input.password).await?;
    let token = crate::pending::issue(&state, &email, &input.name, &hashed).await?;
    audit(&state, &meta, "auth.signup", None).await;
    pad(start).await;
    Ok((
        StatusCode::ACCEPTED,
        [(
            header::SET_COOKIE,
            crate::pending::cookie(&state, &token, 900)?,
        )],
        Json(json!({"data":{"status":"verification_sent","signupToken":token}})),
    )
        .into_response())
}
async fn verify_email(
    State(state): State<AppState>,
    meta: RequestMeta,
    headers: HeaderMap,
    JsonBody(input): JsonBody<SignupCode>,
) -> AppResult<Response> {
    let email = validate::email(&input.email)?;
    validate::length(&input.code, "code", 1, 128)?;
    let token = crate::pending::token(input.signup_token.as_deref(), &headers)?;
    rate(
        &state,
        "code",
        &meta,
        &email,
        limits::CODE_PER_IP,
        Some(limits::CODE_PER_ACCOUNT),
    )
    .await?;
    let (id, session_token) =
        crate::pending::verify(&state, &meta, &email, token, &input.code).await?;
    let user = find(&state, &email)
        .await?
        .filter(|u| u.id == id)
        .ok_or_else(|| AppError::internal("verified user missing"))?;
    audit(&state, &meta, "auth.verified", Some(id)).await;
    let mut response = (
        [(
            header::SET_COOKIE,
            session::cookie(&state.config, &session_token, state.config.session_ttl),
        )],
        Json(json!({"data":{"user":public(&user,&state),"token":session_token}})),
    )
        .into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, crate::pending::cookie(&state, "", 0)?);
    Ok(response)
}
async fn resend(
    State(state): State<AppState>,
    meta: RequestMeta,
    headers: HeaderMap,
    JsonBody(input): JsonBody<Resend>,
) -> AppResult<Response> {
    let start = tokio::time::Instant::now();
    let email = validate::email(&input.email)?;
    validate::length(&input.purpose, "purpose", 1, 32)?;
    if input.purpose != "verify_email" && input.purpose != "reset_password" {
        return Err(validate::failure("purpose", "Choose a valid purpose."));
    }
    rate(
        &state,
        "email",
        &meta,
        &email,
        limits::EMAIL_PER_IP,
        Some(limits::EMAIL_PER_ACCOUNT),
    )
    .await?;
    if input.purpose == "verify_email" {
        // Missing and invalid challenges share the same response as a successful resend.
        if let Ok(token) = crate::pending::token(input.signup_token.as_deref(), &headers) {
            crate::pending::resend(&state, &email, token).await?;
        }
    } else if let Some(user) = find(&state, &email).await?
        && user.status == "active"
    {
        mail_code(&state, &email, &input.purpose, true).await?;
    }
    pad(start).await;
    Ok(accepted())
}
async fn signin(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<Credentials>,
) -> AppResult<Response> {
    let email = validate::email(&input.email)?;
    validate::length(&input.password, "password", 1, 128)?;
    rate(
        &state,
        "signin",
        &meta,
        &email,
        limits::SIGN_IN_PER_IP,
        Some(limits::SIGN_IN_PER_ACCOUNT),
    )
    .await?;
    let user = find(&state, &email).await?;
    let (valid, old) = password::verify(
        &state,
        input.password.clone(),
        user.as_ref().and_then(|u| u.password_hash.clone()),
    )
    .await?;
    if !valid || user.as_ref().is_some_and(|u| !u.verified) {
        audit(
            &state,
            &meta,
            "auth.signin_failed",
            user.as_ref().map(|u| u.id),
        )
        .await;
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That email and password don't match.",
        ));
    }
    let user = user.ok_or_else(|| AppError::internal("verified password without user"))?;
    if user.status == "suspended" {
        return Err(AppError::new(
            ErrorCode::AccountSuspended,
            "This account is suspended.",
        ));
    }
    let upgrade = if old {
        Some(password::hash(&state, input.password).await?)
    } else {
        None
    };
    let response = login_response(&state, &meta, &user, upgrade).await;
    if response.is_ok() {
        security::rate_limit_reset(&state.db, &format!("signin:acct:{email}")).await?;
        audit(&state, &meta, "auth.signin", Some(user.id)).await;
    }
    response
}
async fn signout(
    State(state): State<AppState>,
    meta: RequestMeta,
    headers: HeaderMap,
) -> AppResult<Response> {
    rate(&state, "signout", &meta, "", limits::SIGN_IN_PER_IP, None).await?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| session::read_cookie(&headers, &state.config.session_cookie));
    if let Some(token) = token
        && let Some(found) = session::lookup(&state.db, &state.config, token).await?
    {
        session::revoke(&state.db, found.session_id).await?;
        audit(&state, &meta, "auth.signout", Some(found.user_id)).await;
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session::clear_cookie(&state.config))],
    )
        .into_response())
}
async fn signout_all(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Viewer,
) -> AppResult<Response> {
    rate(
        &state,
        "signout-all",
        &meta,
        &viewer.email,
        limits::SIGN_IN_PER_IP,
        Some(limits::SIGN_IN_PER_ACCOUNT),
    )
    .await?;
    guard_demo(&state, &viewer.email)?;
    session::revoke_all(&state.db, viewer.id, None).await?;
    audit(&state, &meta, "auth.signout", Some(viewer.id)).await;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session::clear_cookie(&state.config))],
    )
        .into_response())
}
async fn current(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    rate(
        &state,
        "session",
        &meta,
        "",
        limits::API_READ_PER_SUBJECT,
        None,
    )
    .await?;
    let user = if let Some(viewer) = &viewer {
        let mut user = viewer_json(viewer);
        user["mfaEnabled"] = json!(crate::mfa::enabled(&state.db, viewer.id).await?);
        Some(user)
    } else {
        None
    };
    Ok(Json(json!({"data":{"user":user}})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmailInput {
    email: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetInput {
    password: String,
    reset_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeInput {
    current_password: String,
    new_password: String,
}

fn invalid_code() -> AppError {
    AppError::new(
        ErrorCode::InvalidCode,
        "That code isn't right, or it has expired.",
    )
}
fn invalid_grant() -> AppError {
    AppError::new(
        ErrorCode::InvalidCode,
        "That reset link has expired. Request a new code.",
    )
}
fn reset_cookie(state: &AppState, token: &str, age: u32) -> AppResult<axum::http::HeaderValue> {
    let secure = if state.config.secure_cookies {
        "; Secure"
    } else {
        ""
    };
    axum::http::HeaderValue::from_str(&format!("reset={token}; Path=/api/v1/auth/password; HttpOnly; SameSite=Strict; Max-Age={age}{secure}")).map_err(AppError::internal)
}
async fn forgot(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<EmailInput>,
) -> AppResult<Response> {
    let start = tokio::time::Instant::now();
    let email = validate::email(&input.email)?;
    rate(
        &state,
        "email",
        &meta,
        &email,
        limits::EMAIL_PER_IP,
        Some(limits::EMAIL_PER_ACCOUNT),
    )
    .await?;
    if let Some(user) = find(&state, &email).await?
        && user.status == "active"
    {
        mail_code(&state, &email, "reset_password", true).await?;
    }
    pad(start).await;
    Ok(accepted())
}
async fn verify_reset(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<CodeInput>,
) -> AppResult<Response> {
    let email = validate::email(&input.email)?;
    validate::length(&input.code, "code", 1, 128)?;
    rate(
        &state,
        "code",
        &meta,
        &email,
        limits::CODE_PER_IP,
        Some(limits::CODE_PER_ACCOUNT),
    )
    .await?;
    if !codes::check(&state, &email, "reset_password", &input.code).await? {
        return Err(invalid_code());
    }
    let user = find(&state, &email)
        .await?
        .filter(|u| u.status == "active")
        .ok_or_else(invalid_code)?;
    let (token, hash) = kernel::crypto::new_token();
    sqlx::query("insert into reset_grants (token_hash,user_id,expires_at) values ($1,$2,now()+interval '10 minutes')").bind(hash.as_slice()).bind(user.id).execute(&state.db).await?;
    Ok((
        [(header::SET_COOKIE, reset_cookie(&state, &token, 600)?)],
        Json(json!({"data":{"resetToken":token}})),
    )
        .into_response())
}
async fn reset_password(
    State(state): State<AppState>,
    meta: RequestMeta,
    headers: HeaderMap,
    JsonBody(input): JsonBody<ResetInput>,
) -> AppResult<Response> {
    rate(
        &state,
        "password-reset",
        &meta,
        "",
        limits::CODE_PER_IP,
        None,
    )
    .await?;
    let token = input
        .reset_token
        .as_deref()
        .or_else(|| session::read_cookie(&headers, "reset"))
        .ok_or_else(invalid_grant)?;
    let hash = kernel::crypto::hash_token(token).ok_or_else(invalid_grant)?;
    let row: Option<(Uuid, String)> = sqlx::query_as("select u.id,u.email::text from users u join reset_grants g on g.user_id=u.id where g.token_hash=$1 and g.used_at is null and g.expires_at>clock_timestamp()")
        .bind(hash.as_slice()).fetch_optional(&state.db).await?;
    let (id, email) = row.ok_or_else(invalid_grant)?;
    guard_demo(&state, &email)?;
    password::policy(&state, &email, &input.password).await?;
    let password_hash = password::hash(&state, input.password).await?;
    let mut tx = state.db.begin().await?;
    // Recheck the grant after acquiring the user lock; hashing must not hold it.
    let locked: Option<(Uuid, String)> = sqlx::query_as("select u.id,u.email::text from users u join reset_grants g on g.user_id=u.id where g.token_hash=$1 for update of u")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    if locked.as_ref() != Some(&(id, email.clone())) {
        return Err(invalid_grant());
    }
    let consumed = sqlx::query("update reset_grants g set used_at=clock_timestamp() from users u where g.token_hash=$1 and g.used_at is null and g.expires_at>clock_timestamp() and u.id=g.user_id and u.deleted_at is null and u.status='active' and (u.password_changed_at is null or g.created_at>u.password_changed_at)")
        .bind(hash.as_slice()).execute(&mut *tx).await?;
    if consumed.rows_affected() != 1 {
        return Err(invalid_grant());
    }
    sqlx::query("update users set password_hash=$1,password_changed_at=clock_timestamp(),email_verified_at=coalesce(email_verified_at,now()) where id=$2").bind(password_hash).bind(id).execute(&mut *tx).await?;
    sqlx::query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // Keep session/challenge issuance under the password reset's user lock.
    let login = crate::mfa::issue_locked(&state, &meta, id, &mut tx).await;
    if let Err(error) = &login
        && error.code != ErrorCode::NotConfigured
    {
        return Err(AppError::internal("reset sign-in failed"));
    }
    tx.commit().await?;
    audit(&state, &meta, "auth.password_reset", Some(id)).await;
    let session_token = match login? {
        crate::mfa::Login::Session(token) => token,
        crate::mfa::Login::Challenge(token) => {
            let mut response = crate::mfa::required(token).into_response();
            response
                .headers_mut()
                .append(header::SET_COOKIE, reset_cookie(&state, "", 0)?);
            return Ok(response);
        }
    };
    let user = find(&state, &email)
        .await?
        .ok_or_else(|| AppError::internal("reset user missing"))?;
    let mut response = (
        [(
            header::SET_COOKIE,
            session::cookie(&state.config, &session_token, state.config.session_ttl),
        )],
        Json(json!({"data":{"user":public(&user,&state),"token":session_token}})),
    )
        .into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, reset_cookie(&state, "", 0)?);
    Ok(response)
}
async fn change_password(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Viewer,
    JsonBody(input): JsonBody<ChangeInput>,
) -> AppResult<Response> {
    rate(
        &state,
        "password-change",
        &meta,
        &viewer.email,
        limits::SIGN_IN_PER_IP,
        Some(limits::PASSWORD_CHANGE_PER_ACCOUNT),
    )
    .await?;
    guard_demo(&state, &viewer.email)?;
    validate::length(&input.current_password, "currentPassword", 1, 128)?;
    let user = find(&state, &viewer.email)
        .await?
        .ok_or_else(AppError::unauthenticated)?;
    let (valid, _) =
        password::verify(&state, input.current_password, user.password_hash.clone()).await?;
    if !valid {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That email and password don't match.",
        ));
    }
    password::policy(&state, &viewer.email, &input.new_password).await?;
    let hash = password::hash(&state, input.new_password).await?;
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query("update users set password_hash=$1,password_changed_at=clock_timestamp() where id=$2 and password_hash=$3 and deleted_at is null and status='active'")
        .bind(hash)
        .bind(viewer.id)
        .bind(&user.password_hash)
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That email and password don't match.",
        ));
    }
    sqlx::query(
        "update sessions set revoked_at=now() where user_id=$1 and id<>$2 and revoked_at is null",
    )
    .bind(viewer.id)
    .bind(viewer.session_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    audit(&state, &meta, "auth.password_changed", Some(viewer.id)).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn sessions(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Viewer,
) -> AppResult<Json<Value>> {
    rate(
        &state,
        "sessions",
        &meta,
        &viewer.email,
        limits::API_READ_PER_SUBJECT,
        None,
    )
    .await?;
    let rows: Vec<Value> = sqlx::query_scalar("select jsonb_build_object('id',id,'createdAt',created_at,'lastSeenAt',last_seen_at,'ip',ip,'userAgent',user_agent,'current',id=$2) from sessions where user_id=$1 and revoked_at is null and expires_at>now() order by created_at desc").bind(viewer.id).bind(viewer.session_id).fetch_all(&state.db).await?;
    Ok(Json(json!({"data":rows})))
}
async fn delete_session(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    rate(
        &state,
        "delete-session",
        &meta,
        &viewer.email,
        limits::API_WRITE_PER_SUBJECT,
        None,
    )
    .await?;
    let result=sqlx::query("update sessions set revoked_at=now() where id=$1 and user_id=$2 and revoked_at is null and expires_at>now()").bind(id).bind(viewer.id).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit(&state, &meta, "auth.signout", Some(viewer.id)).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn demo(State(state): State<AppState>, meta: RequestMeta) -> AppResult<Response> {
    let (email, secret) = match (&state.config.demo_email, &state.config.demo_password) {
        (Some(e), Some(p)) => (validate::email(e)?, p.expose_secret().to_owned()),
        _ => {
            return Err(AppError::new(
                ErrorCode::NotConfigured,
                "Demo sign-in is not configured.",
            ));
        }
    };
    rate(
        &state,
        "signin",
        &meta,
        &email,
        limits::SIGN_IN_PER_IP,
        Some(limits::SIGN_IN_PER_ACCOUNT),
    )
    .await?;
    if find(&state, &email).await?.is_none() {
        password::policy(&state, &email, &secret).await?;
        let hash = password::hash(&state, secret.clone()).await?;
        sqlx::query("insert into users (email,display_name,password_hash,email_verified_at) values ($1,'Demo',$2,now()) on conflict (email) do nothing").bind(&email).bind(hash).execute(&state.db).await?;
    }
    let user = find(&state, &email)
        .await?
        .ok_or_else(AppError::unauthenticated)?;
    let (valid, _) = password::verify(&state, secret, user.password_hash.clone()).await?;
    if !valid || !user.verified || user.status != "active" {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That email and password don't match.",
        ));
    }
    let response = login_response(&state, &meta, &user, None).await;
    if response.is_ok() {
        security::rate_limit_reset(&state.db, &format!("signin:acct:{email}")).await?;
        audit(&state, &meta, "auth.signin", Some(user.id)).await;
    }
    response
}
/// Accounts are provisioned (admins create examiners, examiners enroll candidates, both send invites), so
/// self-signup, email-code verification for signup and one-click demo sign-in are off unless
/// `ALLOW_SELF_SIGNUP=true`. OAuth is not offered.
pub fn router() -> Router<AppState> {
    let router = Router::new()
        .route("/signin", post(signin))
        .route("/signout", post(signout))
        .route("/signout-all", post(signout_all))
        .route("/session", get(current))
        .route("/password/forgot", post(forgot))
        .route("/password/verify-code", post(verify_reset))
        .route("/password/reset", post(reset_password))
        .route("/password/change", post(change_password))
        .route("/sessions", get(sessions))
        .route("/sessions/{id}", axum::routing::delete(delete_session))
        .merge(crate::mfa::router());
    if std::env::var("ALLOW_SELF_SIGNUP").is_ok_and(|v| v == "true") {
        router
            .route("/signup", post(signup))
            .route("/verify-email", post(verify_email))
            .route("/resend-code", post(resend))
            .route("/demo", post(demo))
    } else {
        router
    }
}
