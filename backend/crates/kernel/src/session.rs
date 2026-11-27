//! Opaque server-side sessions. The client holds a random token; the database holds its SHA-256.
//! Revoking a row signs that device out on its very next request.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::http::{HeaderValue, header};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{AppResult, config::Config, crypto, request::RequestMeta};

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct SessionUser {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    #[sqlx(default)]
    pub renewed: bool,
}

/// Shared request-local slot for a renewed session cookie. Debug output never exposes it.
#[derive(Clone, Default)]
pub struct CookieRefresh(Arc<Mutex<Option<HeaderValue>>>);

impl std::fmt::Debug for CookieRefresh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CookieRefresh([redacted])")
    }
}

impl CookieRefresh {
    pub fn take(&self) -> Option<HeaderValue> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    pub(crate) fn queue(&self, value: HeaderValue) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(value);
    }
}

fn max_lifetime(role: &str) -> time::Duration {
    if role == "admin" {
        time::Duration::hours(8)
    } else {
        time::Duration::hours(12)
    }
}

fn absolute_lifetime(config: &Config, role: &str, email: &str) -> time::Duration {
    if role == "admin" || config.admin_emails.contains(&email.to_ascii_lowercase()) {
        time::Duration::hours(8)
    } else {
        max_lifetime(role)
    }
}

fn ttl(config: &Config) -> time::Duration {
    time::Duration::try_from(config.session_ttl).unwrap_or(time::Duration::days(30))
}

/// Starts a session and returns the token to hand to the client (once; it is never stored).
pub async fn create(
    db: &PgPool,
    config: &Config,
    user_id: Uuid,
    request: &RequestMeta,
) -> AppResult<(String, Uuid)> {
    let (token, hash) = crypto::new_token();
    let (role, email): (String, String) =
        sqlx::query_as("select role,email::text from users where id=$1 and deleted_at is null")
            .bind(user_id)
            .fetch_one(db)
            .await?;
    let expires_at = OffsetDateTime::now_utc() + absolute_lifetime(config, &role, &email);
    let id: Uuid = sqlx::query_scalar(
        "insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5) returning id",
    )
    .bind(user_id)
    .bind(hash.as_slice())
    .bind(expires_at)
    .bind(&request.ip)
    .bind(&request.user_agent)
    .fetch_one(db)
    .await?;
    Ok((token, id))
}

/// Looks a token up, with the live role and status. Extends the session when more than half its
/// life is used, so active people stay signed in and idle sessions still expire.
pub async fn lookup(db: &PgPool, config: &Config, token: &str) -> AppResult<Option<SessionUser>> {
    let Some(hash) = crypto::hash_token(token) else {
        return Ok(None);
    };
    let found: Option<SessionUser> = sqlx::query_as(
        "select s.id as session_id, u.id as user_id, u.email::text as email, u.display_name, u.role, u.status, s.expires_at, s.created_at
         from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.deleted_at is null",
    )
    .bind(hash.as_slice())
    .fetch_optional(db)
    .await?;

    let Some(mut session) = found else {
        return Ok(None);
    };
    let absolute_expiry =
        session.created_at + absolute_lifetime(config, &session.role, &session.email);
    if absolute_expiry <= OffsetDateTime::now_utc() {
        revoke(db, session.session_id).await?;
        return Ok(None);
    }
    let life = ttl(config);
    if session.expires_at - OffsetDateTime::now_utc() < life / 2 {
        let now = OffsetDateTime::now_utc();
        let sliding_expiry = now + life;
        let clamped_expiry = if sliding_expiry < absolute_expiry {
            sliding_expiry
        } else {
            absolute_expiry
        };
        // Do not refresh a cookie when the absolute deadline prevents a useful extension.
        if clamped_expiry <= session.expires_at + time::Duration::minutes(1) {
            return Ok(Some(session));
        }
        let expires_at: Option<OffsetDateTime> = sqlx::query_scalar("update sessions set expires_at = $2, last_seen_at = now() where id = $1 and revoked_at is null and expires_at > now() returning expires_at")
            .bind(session.session_id)
            .bind(clamped_expiry)
            .fetch_optional(db)
            .await?;
        let Some(expires_at) = expires_at else {
            return Ok(None);
        };
        session.expires_at = expires_at;
        session.renewed = true;
    }
    Ok(Some(session))
}

pub async fn revoke(db: &PgPool, session_id: Uuid) -> AppResult<()> {
    sqlx::query("update sessions set revoked_at = now() where id = $1 and revoked_at is null")
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Signs a user out everywhere, optionally keeping the current device.
pub async fn revoke_all(db: &PgPool, user_id: Uuid, keep: Option<Uuid>) -> AppResult<u64> {
    let done = sqlx::query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2)")
        .bind(user_id)
        .bind(keep)
        .execute(db)
        .await?;
    Ok(done.rows_affected())
}

/// The Set-Cookie header for a session. HttpOnly so scripts can't read it, SameSite=Lax against
/// cross-site sends, Secure in production, Path=/ and no Domain (required by the __Host- prefix).
pub fn cookie(config: &Config, token: &str, max_age: Duration) -> HeaderValue {
    let secure = if config.secure_cookies {
        "; Secure"
    } else {
        ""
    };
    let value = format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{secure}",
        config.session_cookie,
        max_age.as_secs()
    );
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// The Set-Cookie header that deletes the session cookie.
pub fn clear_cookie(config: &Config) -> HeaderValue {
    cookie(config, "", Duration::ZERO)
}

/// Reads a named cookie from the request headers.
pub fn read_cookie<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_lifetimes_are_role_specific() {
        assert_eq!(max_lifetime("admin"), time::Duration::hours(8));
        assert_eq!(max_lifetime("examiner"), time::Duration::hours(12));
        assert_eq!(max_lifetime("user"), time::Duration::hours(12));
    }

    #[test]
    #[allow(clippy::expect_used)]
    fn configured_admin_accounts_get_the_shorter_absolute_lifetime() {
        let mut config = Config::from_env().expect("test config");
        config.admin_emails.insert("root@example.test".into());
        assert_eq!(
            absolute_lifetime(&config, "user", "ROOT@example.test"),
            time::Duration::hours(8)
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn lookup_revokes_a_session_past_its_absolute_deadline(db: PgPool) -> AppResult<()> {
        let config = Config::from_env().map_err(crate::AppError::internal)?;
        let user: Uuid = sqlx::query_scalar(
            "insert into users(email,display_name,role) values('absolute-expiry@example.test','Candidate','user') returning id",
        )
        .fetch_one(&db)
        .await?;
        let (token, hash) = crypto::new_token();
        let session_id: Uuid = sqlx::query_scalar(
            "insert into sessions(user_id,token_hash,created_at,expires_at) values($1,$2,now()-interval '13 hours',now()+interval '1 day') returning id",
        )
        .bind(user)
        .bind(hash.as_slice())
        .fetch_one(&db)
        .await?;
        assert!(lookup(&db, &config, &token).await?.is_none());
        let revoked: bool =
            sqlx::query_scalar("select revoked_at is not null from sessions where id=$1")
                .bind(session_id)
                .fetch_one(&db)
                .await?;
        assert!(revoked);
        Ok(())
    }
}
