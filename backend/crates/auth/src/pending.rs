use crate::{emails, validate};
use axum::http::{HeaderMap, HeaderValue};
use kernel::{AppError, AppResult, AppState, ErrorCode, crypto, request::RequestMeta, session};
use secrecy::ExposeSecret;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidCode,
        "That code isn't right, or it has expired.",
    )
}
fn digest(state: &AppState, token_hash: &[u8], code: &str) -> [u8; 32] {
    crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"signup-code", token_hash, code.as_bytes()],
    )
}
pub fn token<'a>(body: Option<&'a str>, headers: &'a HeaderMap) -> AppResult<&'a str> {
    let token = body
        .or_else(|| session::read_cookie(headers, "signup"))
        .ok_or_else(invalid)?;
    validate::length(token, "signupToken", 1, 128)?;
    crypto::hash_token(token).ok_or_else(invalid)?;
    Ok(token)
}
pub fn cookie(state: &AppState, token: &str, age: u32) -> AppResult<HeaderValue> {
    let secure = if state.config.secure_cookies {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "signup={token}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age={age}{secure}"
    ))
    .map_err(AppError::internal)
}
async fn lock(tx: &mut Transaction<'_, Postgres>, email: &str) -> AppResult<()> {
    // A transaction lock also covers emails without a users row. Hash collisions only serialize work.
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 250))")
        .bind(email)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub async fn issue(state: &AppState, email: &str, name: &str, password: &str) -> AppResult<String> {
    let (token, hash) = crypto::new_token();
    let code = crypto::random_digits(6);
    let mut tx = state.db.begin().await?;
    lock(&mut tx, email).await?;
    let registered: bool = sqlx::query_scalar("select exists(select 1 from users where email=$1 and (email_verified_at is not null or deleted_at is not null))")
        .bind(email).fetch_one(&mut *tx).await?;
    if registered {
        tx.commit().await?;
        emails::send(state, emails::notice(state, email));
    } else {
        sqlx::query("delete from pending_signups where email=$1 and (expires_at<=clock_timestamp() or attempts>=5)")
            .bind(email).execute(&mut *tx).await?;
        // Keep the latest four before inserting, so simultaneous signups cannot exceed five.
        sqlx::query("delete from pending_signups where id in (select id from pending_signups where email=$1 order by created_at desc,id desc offset 4)")
            .bind(email).execute(&mut *tx).await?;
        sqlx::query("insert into pending_signups(email,token_hash,code_hash,password_hash,display_name,expires_at) values($1,$2,$3,$4,$5,clock_timestamp()+interval '15 minutes')")
            .bind(email).bind(hash.as_slice()).bind(digest(state, &hash, &code).as_slice()).bind(password).bind(name).execute(&mut *tx).await?;
        tx.commit().await?;
        emails::send(state, emails::code(state, email, &code));
    }
    Ok(token)
}
pub async fn verify(
    state: &AppState,
    meta: &RequestMeta,
    email: &str,
    token: &str,
    code: &str,
) -> AppResult<(Uuid, String)> {
    let hash = crypto::hash_token(token).ok_or_else(invalid)?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, email).await?;
    let stored: Option<Vec<u8>> = sqlx::query_scalar("update pending_signups set attempts=attempts+1 where email=$1 and token_hash=$2 and attempts<5 and expires_at>clock_timestamp() returning code_hash")
        .bind(email).bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let expected = digest(state, &hash, code);
    if !stored
        .as_ref()
        .is_some_and(|v| crypto::constant_time_eq(v, &expected))
    {
        // Commit wrong attempts too; rolling back would allow unlimited guesses.
        tx.commit().await?;
        return Err(invalid());
    }
    let (password, name): (String, String) = sqlx::query_as("delete from pending_signups where email=$1 and token_hash=$2 returning password_hash,display_name")
        .bind(email).bind(hash.as_slice()).fetch_one(&mut *tx).await?;
    let id: Option<Uuid> = sqlx::query_scalar("insert into users(email,password_hash,display_name,email_verified_at,password_changed_at) values($1,$2,$3,clock_timestamp(),clock_timestamp()) on conflict(email) do update set password_hash=excluded.password_hash,display_name=excluded.display_name,email_verified_at=excluded.email_verified_at,password_changed_at=excluded.password_changed_at where users.email_verified_at is null and users.deleted_at is null and users.status='active' returning id")
        .bind(email).bind(password).bind(name).fetch_optional(&mut *tx).await?;
    let Some(id) = id else {
        tx.commit().await?;
        return Err(AppError::new(
            ErrorCode::Conflict,
            "This email is already registered. Sign in instead.",
        ));
    };
    sqlx::query("delete from pending_signups where email=$1")
        .bind(email)
        .execute(&mut *tx)
        .await?;
    let (session_token, session_hash) = crypto::new_token();
    sqlx::query("insert into sessions(user_id,token_hash,expires_at,ip,user_agent) values($1,$2,clock_timestamp()+make_interval(secs => $3),$4,$5)")
        .bind(id).bind(session_hash.as_slice()).bind(state.config.session_ttl.as_secs_f64()).bind(&meta.ip).bind(&meta.user_agent).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((id, session_token))
}
pub async fn resend(state: &AppState, email: &str, token: &str) -> AppResult<()> {
    let Some(hash) = crypto::hash_token(token) else {
        return Ok(());
    };
    let code = crypto::random_digits(6);
    let mut tx = state.db.begin().await?;
    lock(&mut tx, email).await?;
    // Never reset attempts or extend expiry: resend must not multiply guessing budgets.
    let changed = sqlx::query("update pending_signups set code_hash=$3,code_sent_at=clock_timestamp() where email=$1 and token_hash=$2 and attempts<5 and expires_at>clock_timestamp() and code_sent_at<=clock_timestamp()-interval '30 seconds'")
        .bind(email).bind(hash.as_slice()).bind(digest(state, &hash, &code).as_slice()).execute(&mut *tx).await?;
    tx.commit().await?;
    if changed.rows_affected() == 1 {
        emails::send(state, emails::code(state, email, &code));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn signup_hmac_binds_challenge_and_code() {
        let hash = |token: &[u8], code: &[u8]| {
            kernel::crypto::hmac_sha256(b"pepper", &[b"signup-code", token, code])
        };
        assert_ne!(hash(b"first", b"123456"), hash(b"second", b"123456"));
        assert_ne!(hash(b"first", b"123456"), hash(b"first", b"654321"));
    }
    #[sqlx::test(migrations = "../../migrations")]
    #[allow(clippy::unwrap_used)]
    async fn simultaneous_issues_keep_at_most_five(db: sqlx::PgPool) {
        use std::sync::Arc;
        let state = kernel::AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let mut tasks = Vec::new();
        for _ in 0..12 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move {
                super::issue(&state, "a@example.com", "Test", "test-only-hash")
                    .await
                    .unwrap()
            }));
        }
        let mut tokens = std::collections::HashSet::new();
        for task in tasks {
            assert!(tokens.insert(task.await.unwrap()));
        }
        let count: i64 = sqlx::query_scalar(
            "select count(*) from pending_signups where email='a@example.com' and expires_at>now()",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(count, 5);
        let count: i64 = sqlx::query_scalar("select count(*) from users")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
