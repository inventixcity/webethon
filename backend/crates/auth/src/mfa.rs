//! User-row locks serialize factor changes, challenge completion and session issuance.
use crate::{password, totp, validate};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer, crypto,
    extract::Json as JsonBody,
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    session,
};
use rand::{Rng, RngCore, rngs::OsRng};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

fn not_configured() -> AppError {
    AppError::new(
        ErrorCode::NotConfigured,
        "Two-step sign-in is not configured.",
    )
}
fn key_from(raw: Option<&str>, production: bool) -> AppResult<[u8; 32]> {
    if let Some(raw) = raw {
        return STANDARD
            .decode(raw.trim())
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(not_configured);
    }
    if production {
        return Err(not_configured());
    }
    static WARNING: std::sync::Once = std::sync::Once::new();
    WARNING.call_once(|| {
        tracing::warn!(
            "MFA uses a development-only encryption key; set MFA_ENCRYPTION_KEY before production"
        )
    });
    Ok(crypto::sha256(
        b"invigil MFA development only encryption key",
    ))
}
fn key(state: &AppState) -> AppResult<[u8; 32]> {
    key_from(
        std::env::var("MFA_ENCRYPTION_KEY").ok().as_deref(),
        state.config.is_production(),
    )
}
fn encrypt(key: &[u8; 32], id: Uuid, secret: &[u8]) -> AppResult<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(AppError::internal)?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: secret,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| AppError::internal("MFA encryption failed"))?;
    Ok((ciphertext, nonce.to_vec()))
}
fn decrypt(key: &[u8; 32], id: Uuid, ciphertext: &[u8], nonce: &[u8]) -> AppResult<Vec<u8>> {
    let nonce: [u8; 12] = nonce.try_into().map_err(AppError::internal)?;
    Aes256Gcm::new_from_slice(key)
        .map_err(AppError::internal)?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| AppError::internal("MFA decryption failed"))
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidCode, "That code isn't right.")
}
pub(crate) fn required(token: String) -> AppError {
    AppError::new(
        ErrorCode::MfaRequired,
        "Enter the code from your authenticator app.",
    )
    .with_details(json!({"mfaToken":token}))
}
pub(crate) async fn enabled(db: &sqlx::PgPool, id: Uuid) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null)",
    )
    .bind(id)
    .fetch_one(db)
    .await?)
}
pub(crate) async fn lock_user(conn: &mut PgConnection, id: Uuid) -> AppResult<()> {
    let active: Option<bool> = sqlx::query_scalar(
        "select status='active' and deleted_at is null from users where id=$1 for update",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    if active != Some(true) {
        return Err(AppError::unauthenticated());
    }
    Ok(())
}

pub(crate) enum Login {
    Session(String),
    Challenge(String),
}
/// The caller must hold the user row until commit, including password reset's existing transaction.
pub(crate) async fn issue_locked(
    state: &AppState,
    meta: &RequestMeta,
    id: Uuid,
    conn: &mut PgConnection,
) -> AppResult<Login> {
    let enabled: bool = sqlx::query_scalar(
        "select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null)",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if enabled {
        key(state)?;
        // Issuance holds the user lock, keeping concurrent challenges bounded.
        sqlx::query("delete from mfa_challenges where user_id=$1 and token_hash in (select token_hash from mfa_challenges where user_id=$1 and used_at is null and expires_at>clock_timestamp() order by expires_at, token_hash offset 4)").bind(id).execute(&mut *conn).await?;
        let (token, hash) = crypto::new_token();
        sqlx::query("insert into mfa_challenges(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '5 minutes')").bind(hash.as_slice()).bind(id).execute(conn).await?;
        Ok(Login::Challenge(token))
    } else {
        Ok(Login::Session(insert_session(state, meta, id, conn).await?))
    }
}
pub(crate) async fn issue(state: &AppState, meta: &RequestMeta, id: Uuid) -> AppResult<Login> {
    let mut tx = state.db.begin().await?;
    lock_user(&mut tx, id).await?;
    let result = issue_locked(state, meta, id, &mut tx).await?;
    tx.commit().await?;
    Ok(result)
}
async fn insert_session(
    state: &AppState,
    meta: &RequestMeta,
    id: Uuid,
    conn: &mut PgConnection,
) -> AppResult<String> {
    let (token, hash) = crypto::new_token();
    let seconds = state.config.session_ttl.as_secs_f64();
    sqlx::query("insert into sessions(user_id,token_hash,expires_at,ip,user_agent) values($1,$2,clock_timestamp()+make_interval(secs => $3),$4,$5)").bind(id).bind(hash.as_slice()).bind(seconds).bind(&meta.ip).bind(&meta.user_agent).execute(conn).await?;
    Ok(token)
}
async fn audit(state: &AppState, meta: &RequestMeta, action: &str, id: Uuid) {
    security::audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(id),
            target_type: Some("user"),
            target_id: Some(id.to_string()),
            meta: json!({}),
        },
    )
    .await;
}
async fn management_rate(state: &AppState, meta: &RequestMeta, viewer: &Viewer) -> AppResult<()> {
    security::enforce_rate_limit(
        &state.db,
        &format!("mfa:manage:ip:{}", meta.ip),
        state.config.scaled_ip_limit(limits::CODE_PER_IP),
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("mfa:manage:account:{}", viewer.id),
        limits::PASSWORD_CHANGE_PER_ACCOUNT,
    )
    .await?;
    Ok(())
}
async fn management_tx<'a>(
    state: &'a AppState,
    viewer: &Viewer,
) -> AppResult<Transaction<'a, Postgres>> {
    crate::routes::guard_demo(state, &viewer.email)?;
    let mut tx = state.db.begin().await?;
    lock_user(&mut tx, viewer.id).await?;
    // A Viewer resolved before an enable/disable must not revive a revoked session.
    let live: bool = sqlx::query_scalar("select exists(select 1 from sessions where id=$1 and user_id=$2 and revoked_at is null and expires_at>clock_timestamp())").bind(viewer.session_id).bind(viewer.id).fetch_one(&mut *tx).await?;
    if !live {
        return Err(AppError::unauthenticated());
    }
    Ok(tx)
}
async fn check_password(state: &AppState, id: Uuid, value: String) -> AppResult<String> {
    validate::length(&value, "currentPassword", 1, 128)?;
    let hash: Option<String> = sqlx::query_scalar("select password_hash from users where id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if !password::verify(state, value, hash.clone()).await?.0 {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That password isn't right.",
        ));
    }
    hash.ok_or_else(AppError::unauthenticated)
}
async fn recheck_password(conn: &mut PgConnection, id: Uuid, expected: &str) -> AppResult<()> {
    let actual: Option<String> = sqlx::query_scalar("select password_hash from users where id=$1")
        .bind(id)
        .fetch_one(conn)
        .await?;
    if !actual
        .as_deref()
        .is_some_and(|actual| crypto::constant_time_eq(actual.as_bytes(), expected.as_bytes()))
    {
        return Err(AppError::new(
            ErrorCode::InvalidCredentials,
            "That password isn't right.",
        ));
    }
    Ok(())
}
fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut result = String::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        result.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    result
}
fn recovery_hash(state: &AppState, id: Uuid, value: &str) -> [u8; 32] {
    let normal: String = value
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect();
    crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"recovery", id.as_bytes(), normal.as_bytes()],
    )
}
async fn recovery_codes(
    state: &AppState,
    conn: &mut PgConnection,
    id: Uuid,
) -> AppResult<Vec<String>> {
    sqlx::query("delete from mfa_recovery_codes where user_id=$1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let mut codes = Vec::with_capacity(10);
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    for _ in 0..10 {
        let raw: String = (0..12)
            .map(|_| char::from(ALPHABET[OsRng.gen_range(0..ALPHABET.len())]))
            .collect();
        let code = format!("{}-{}-{}", &raw[..4], &raw[4..8], &raw[8..]);
        let hash = recovery_hash(state, id, &code);
        sqlx::query("insert into mfa_recovery_codes(user_id,code_hash) values($1,$2)")
            .bind(id)
            .bind(hash.as_slice())
            .execute(&mut *conn)
            .await?;
        codes.push(code);
    }
    Ok(codes)
}
#[derive(sqlx::FromRow)]
struct Factor {
    secret_ciphertext: Vec<u8>,
    secret_nonce: Vec<u8>,
    enabled: bool,
}
async fn factor(conn: &mut PgConnection, id: Uuid) -> AppResult<Factor> {
    sqlx::query_as("select secret_ciphertext,secret_nonce,enabled_at is not null as enabled from mfa_totp where user_id=$1 for update").bind(id).fetch_optional(conn).await?.ok_or_else(invalid)
}
async fn consume_totp(
    conn: &mut PgConnection,
    id: Uuid,
    factor: &Factor,
    key: &[u8; 32],
    code: &str,
) -> AppResult<()> {
    let secret = decrypt(key, id, &factor.secret_ciphertext, &factor.secret_nonce)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(AppError::internal)?
        .as_secs();
    let step = totp::matching_step(&secret, code, now).ok_or_else(invalid)?;
    let changed = sqlx::query("update mfa_totp set last_used_step=$2 where user_id=$1 and (last_used_step is null or last_used_step<$2)").bind(id).bind(step).execute(conn).await?;
    if changed.rows_affected() != 1 {
        return Err(invalid());
    }
    Ok(())
}
async fn consume_recovery(
    state: &AppState,
    conn: &mut PgConnection,
    id: Uuid,
    code: &str,
) -> AppResult<()> {
    let hash = recovery_hash(state, id, code);
    // Compare all stored hashes with the constant-time helper before the guarded update.
    let hashes: Vec<Vec<u8>> = sqlx::query_scalar(
        "select code_hash from mfa_recovery_codes where user_id=$1 and used_at is null",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let found = hashes.iter().fold(false, |found, stored| {
        crypto::constant_time_eq(stored, &hash) | found
    });
    if !found {
        return Err(invalid());
    }
    let changed = sqlx::query("update mfa_recovery_codes set used_at=clock_timestamp() where user_id=$1 and code_hash=$2 and used_at is null").bind(id).bind(hash.as_slice()).execute(conn).await?;
    if changed.rows_affected() != 1 {
        return Err(invalid());
    }
    Ok(())
}
async fn revoke_others(conn: &mut PgConnection, v: &Viewer) -> AppResult<()> {
    sqlx::query("update sessions set revoked_at=clock_timestamp() where user_id=$1 and id<>$2 and revoked_at is null").bind(v.id).bind(v.session_id).execute(&mut *conn).await?;
    // Challenges issued before a factor change must not sign in afterward.
    sqlx::query("delete from mfa_challenges where user_id=$1")
        .bind(v.id)
        .execute(conn)
        .await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PasswordInput {
    current_password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeInput {
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManageInput {
    current_password: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyInput {
    mfa_token: String,
    code: Option<String>,
    recovery_code: Option<String>,
}
async fn status(
    State(state): State<AppState>,
    meta: RequestMeta,
    v: Viewer,
) -> AppResult<Json<Value>> {
    key(&state)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("mfa:read:{}:{}", v.id, meta.ip),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let row: (bool,i64) = sqlx::query_as("select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null),(select count(*) from mfa_recovery_codes where user_id=$1 and used_at is null)").bind(v.id).fetch_one(&state.db).await?;
    Ok(Json(
        json!({"data":{"totpEnabled":row.0,"recoveryCodesRemaining":row.1}}),
    ))
}
async fn setup(
    State(state): State<AppState>,
    meta: RequestMeta,
    v: Viewer,
    JsonBody(input): JsonBody<PasswordInput>,
) -> AppResult<Json<Value>> {
    let key = key(&state)?;
    management_rate(&state, &meta, &v).await?;
    crate::routes::guard_demo(&state, &v.email)?;
    let password_hash = check_password(&state, v.id, input.current_password).await?;
    let mut tx = management_tx(&state, &v).await?;
    recheck_password(&mut tx, v.id, &password_hash).await?;
    let enabled: bool = sqlx::query_scalar(
        "select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null)",
    )
    .bind(v.id)
    .fetch_one(&mut *tx)
    .await?;
    if enabled {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Two-step sign-in is already enabled.",
        ));
    }
    let mut secret = [0u8; 20];
    OsRng.fill_bytes(&mut secret);
    let (ciphertext, nonce) = encrypt(&key, v.id, &secret)?;
    sqlx::query("insert into mfa_totp(user_id,secret_ciphertext,secret_nonce) values($1,$2,$3) on conflict(user_id) do update set secret_ciphertext=$2,secret_nonce=$3,last_used_step=null,created_at=clock_timestamp()").bind(v.id).bind(ciphertext).bind(nonce).execute(&mut *tx).await?;
    let secret = base32(&secret);
    let mailbox: lettre::message::Mailbox = state
        .config
        .email_from
        .parse()
        .map_err(AppError::internal)?;
    let issuer = mailbox
        .name
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("Invigil");
    let mut url = reqwest::Url::parse("otpauth://totp/").map_err(AppError::internal)?;
    url.path_segments_mut()
        .map_err(|_| AppError::internal("invalid TOTP URL"))?
        .pop_if_empty()
        .push(&format!("{issuer}:{}", v.email));
    url.query_pairs_mut()
        .append_pair("secret", &secret)
        .append_pair("issuer", issuer)
        .append_pair("algorithm", "SHA1")
        .append_pair("digits", "6")
        .append_pair("period", "30");
    let qr = qrcode::QrCode::new(url.as_str().as_bytes())
        .map_err(AppError::internal)?
        .render::<qrcode::render::svg::Color>()
        .build();
    tx.commit().await?;
    Ok(Json(
        json!({"data":{"secret":secret,"otpauthUrl":url.as_str(),"qrSvg":qr}}),
    ))
}
async fn enable(
    State(state): State<AppState>,
    meta: RequestMeta,
    v: Viewer,
    JsonBody(input): JsonBody<CodeInput>,
) -> AppResult<Json<Value>> {
    let key = key(&state)?;
    management_rate(&state, &meta, &v).await?;
    validate::length(&input.code, "code", 6, 6)?;
    let mut tx = management_tx(&state, &v).await?;
    let f = factor(&mut tx, v.id).await?;
    if f.enabled {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Two-step sign-in is already enabled.",
        ));
    }
    consume_totp(&mut tx, v.id, &f, &key, &input.code).await?;
    sqlx::query("update mfa_totp set enabled_at=clock_timestamp() where user_id=$1")
        .bind(v.id)
        .execute(&mut *tx)
        .await?;
    let codes = recovery_codes(&state, &mut tx, v.id).await?;
    revoke_others(&mut tx, &v).await?;
    tx.commit().await?;
    audit(&state, &meta, "auth.mfa_enabled", v.id).await;
    Ok(Json(json!({"data":{"recoveryCodes":codes}})))
}
async fn manage(
    state: &AppState,
    meta: &RequestMeta,
    v: &Viewer,
    input: ManageInput,
    disable: bool,
) -> AppResult<Response> {
    let key = key(state)?;
    management_rate(state, meta, v).await?;
    validate::length(&input.code, "code", 1, 64)?;
    crate::routes::guard_demo(state, &v.email)?;
    let password_hash = check_password(state, v.id, input.current_password).await?;
    let mut tx = management_tx(state, v).await?;
    recheck_password(&mut tx, v.id, &password_hash).await?;
    let f = factor(&mut tx, v.id).await?;
    if !f.enabled {
        return Err(invalid());
    }
    if input.code.len() == 6 && input.code.bytes().all(|b| b.is_ascii_digit()) {
        consume_totp(&mut tx, v.id, &f, &key, &input.code).await?;
    } else {
        consume_recovery(state, &mut tx, v.id, &input.code).await?;
    }
    let result = if disable {
        sqlx::query("delete from mfa_totp where user_id=$1")
            .bind(v.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from mfa_recovery_codes where user_id=$1")
            .bind(v.id)
            .execute(&mut *tx)
            .await?;
        StatusCode::NO_CONTENT.into_response()
    } else {
        Json(json!({"data":{"recoveryCodes":recovery_codes(state,&mut tx,v.id).await?}}))
            .into_response()
    };
    revoke_others(&mut tx, v).await?;
    tx.commit().await?;
    audit(
        state,
        meta,
        if disable {
            "auth.mfa_disabled"
        } else {
            "auth.mfa_recovery_regenerated"
        },
        v.id,
    )
    .await;
    Ok(result)
}
async fn disable(
    State(s): State<AppState>,
    m: RequestMeta,
    v: Viewer,
    JsonBody(i): JsonBody<ManageInput>,
) -> AppResult<Response> {
    manage(&s, &m, &v, i, true).await
}
async fn regenerate(
    State(s): State<AppState>,
    m: RequestMeta,
    v: Viewer,
    JsonBody(i): JsonBody<ManageInput>,
) -> AppResult<Response> {
    manage(&s, &m, &v, i, false).await
}
async fn verify(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<VerifyInput>,
) -> AppResult<Response> {
    let key = key(&state)?;
    validate::length(&input.mfa_token, "mfaToken", 1, 128)?;
    let (code, recovery) = match (&input.code, &input.recovery_code) {
        (Some(c), None) => {
            validate::length(c, "code", 1, 64)?;
            (c, false)
        }
        (None, Some(c)) => {
            validate::length(c, "recoveryCode", 1, 64)?;
            (c, true)
        }
        _ => {
            return Err(validate::failure(
                "code",
                "Enter one authenticator code or recovery code.",
            ));
        }
    };
    security::enforce_rate_limit(
        &state.db,
        &format!("mfa:verify:ip:{}", meta.ip),
        state.config.scaled_ip_limit(limits::CODE_PER_IP),
    )
    .await?;
    let hash = crypto::hash_token(&input.mfa_token).ok_or_else(invalid)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("mfa:verify:token:{}", STANDARD.encode(hash)),
        limits::CODE_PER_ACCOUNT,
    )
    .await?;
    // Autocommit is deliberate: rollback, cancellation or a bad factor cannot refund a guess.
    let attempt: Option<(Uuid, bool, i64)> = sqlx::query_as("with attempt as (update mfa_challenges set attempts=attempts+1 where token_hash=$1 and used_at is null and expires_at>clock_timestamp() and attempts<5 returning user_id) select a.user_id, r.allowed, greatest(1, ceil(extract(epoch from (r.reset_at-clock_timestamp())))::bigint) from attempt a cross join lateral rate_limit_hit(translate(rtrim(encode(sha256(convert_to('mfa:verify:account:' || a.user_id::text, 'UTF8')), 'base64'), '='), '+/', '-_'), 10, 3600) r")
        .bind(hash.as_slice()).fetch_optional(&state.db).await?;
    let Some((id, allowed, wait)) = attempt else {
        let id: Option<Uuid> =
            sqlx::query_scalar("select user_id from mfa_challenges where token_hash=$1")
                .bind(hash.as_slice())
                .fetch_optional(&state.db)
                .await?;
        security::audit(
            &state.db,
            &meta,
            AuditEntry {
                action: "auth.mfa_failed",
                actor_id: id,
                target_type: Some("user"),
                target_id: id.map(|id| id.to_string()),
                meta: json!({}),
            },
        )
        .await;
        return Err(invalid());
    };
    if !allowed {
        return Err(AppError::new(
            ErrorCode::RateLimited,
            "Too many attempts. Please wait a little and try again.",
        )
        .retry_after(u64::try_from(wait).unwrap_or(1)));
    }
    let result = async {
        let mut tx = state.db.begin().await?;
        lock_user(&mut tx,id).await?;
        let live: bool = sqlx::query_scalar("select exists(select 1 from mfa_challenges where token_hash=$1 and user_id=$2 and used_at is null and expires_at>clock_timestamp() and attempts<=5)").bind(hash.as_slice()).bind(id).fetch_one(&mut *tx).await?;
        if !live { return Err(invalid()); }
        let f = factor(&mut tx,id).await?;
        if !f.enabled { return Err(invalid()); }
        if recovery { consume_recovery(&state,&mut tx,id,code).await?; }
        else { consume_totp(&mut tx,id,&f,&key,code).await?; }
        let used = sqlx::query("update mfa_challenges set used_at=clock_timestamp() where token_hash=$1 and used_at is null and expires_at>clock_timestamp() and attempts<=5").bind(hash.as_slice()).execute(&mut *tx).await?;
        if used.rows_affected()!=1 { return Err(invalid()); }
        let token = insert_session(&state,&meta,id,&mut tx).await?;
        let mut user: Value = sqlx::query_scalar("select jsonb_build_object('id',id,'email',email,'displayName',display_name,'role',role,'mfaEnabled',true) from users where id=$1").bind(id).fetch_one(&mut *tx).await?;
        if user["email"].as_str().is_some_and(|e| state.config.admin_emails.contains(e)) { user["role"]=json!("admin"); }
        tx.commit().await?;
        Ok::<_,AppError>((token,user))
    }.await;
    match result {
        Ok((token, user)) => {
            security::rate_limit_reset(&state.db, &format!("mfa:verify:account:{id}")).await?;
            if let Some(email) = user["email"].as_str() {
                security::rate_limit_reset(&state.db, &format!("signin:acct:{email}")).await?;
            }
            audit(&state, &meta, "auth.mfa_verified", id).await;
            Ok((
                [(
                    header::SET_COOKIE,
                    session::cookie(&state.config, &token, state.config.session_ttl),
                )],
                Json(json!({"data":{"user":user,"token":token}})),
            )
                .into_response())
        }
        Err(error) => {
            audit(&state, &meta, "auth.mfa_failed", id).await;
            Err(error)
        }
    }
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/mfa", get(status))
        .route("/mfa/totp/setup", post(setup))
        .route("/mfa/totp/enable", post(enable))
        .route("/mfa/totp/disable", post(disable))
        .route("/mfa/recovery-codes", post(regenerate))
        .route("/mfa/verify", post(verify))
}

/// Reauthenticate an administrator while holding the user and session locks.
/// The caller must commit the transaction only after recording the step-up.
pub async fn admin_reauthenticate(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    viewer: &Viewer,
    password: String,
    code: Option<String>,
) -> AppResult<()> {
    viewer.require_admin()?;
    let password_hash = check_password(state, viewer.id, password).await?;
    lock_user(tx, viewer.id).await?;
    recheck_password(tx, viewer.id, &password_hash).await?;
    let (role, email): (String, String) =
        sqlx::query_as("select role,email::text from users where id=$1")
            .bind(viewer.id)
            .fetch_one(&mut **tx)
            .await?;
    if role != "admin"
        && !state
            .config
            .admin_emails
            .contains(&email.to_ascii_lowercase())
    {
        return Err(AppError::forbidden());
    }
    let live: bool = sqlx::query_scalar("select exists(select 1 from sessions where id=$1 and user_id=$2 and revoked_at is null and expires_at>clock_timestamp() for update)")
        .bind(viewer.session_id).bind(viewer.id).fetch_one(&mut **tx).await?;
    if !live {
        return Err(AppError::unauthenticated());
    }
    let enabled: bool = sqlx::query_scalar(
        "select exists(select 1 from mfa_totp where user_id=$1 and enabled_at is not null)",
    )
    .bind(viewer.id)
    .fetch_one(&mut **tx)
    .await?;
    if enabled {
        let code = code.ok_or_else(invalid)?;
        if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        let f = factor(tx, viewer.id).await?;
        consume_totp(tx, viewer.id, &f, &key(state)?, &code).await?;
    } else if code.as_ref().is_some_and(|c| c.len() > 64) {
        return Err(validate::failure("code", "Code is too long."));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn ciphertext_bound_to_user_and_authenticated() {
        let key = [7; 32];
        let id = Uuid::new_v4();
        let (mut ciphertext, nonce) = encrypt(&key, id, b"secret").unwrap();
        assert_eq!(decrypt(&key, id, &ciphertext, &nonce).unwrap(), b"secret");
        assert!(decrypt(&key, Uuid::new_v4(), &ciphertext, &nonce).is_err());
        ciphertext[0] ^= 1;
        assert!(decrypt(&key, id, &ciphertext, &nonce).is_err());
        assert!(decrypt(&key, id, &ciphertext, &nonce[..2]).is_err());
    }
    #[test]
    fn production_key_validation() {
        for raw in [None, Some(""), Some("garbage"), Some("c2hvcnQ=")] {
            assert_eq!(
                key_from(raw, true).unwrap_err().code,
                ErrorCode::NotConfigured
            );
        }
        assert_eq!(
            key_from(Some(&STANDARD.encode([1; 32])), true).unwrap(),
            [1; 32]
        );
        assert!(key_from(None, false).is_ok());
        assert_eq!(
            base32(b"12345678901234567890"),
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        );
    }
}
