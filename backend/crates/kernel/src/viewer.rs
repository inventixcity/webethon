//! The signed-in person, taken from `Authorization: Bearer <token>` or the session cookie.
//! The token proves who they are; the database decides what they may do on every request.

use axum::{
    extract::{FromRequestParts, OptionalFromRequestParts},
    http::{header, request::Parts},
};
use uuid::Uuid;

use crate::{AppError, AppState, ErrorCode, session};

#[derive(Clone, Debug)]
pub struct Viewer {
    pub id: Uuid,
    pub session_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: Role,
    /// True when the token came from a cookie, so the request needs the cross-site check.
    pub via_cookie: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Stored as `user`; presented to clients as `candidate`.
    User,
    Examiner,
    Admin,
}

impl Role {
    /// The role name clients see: `admin`, `examiner` or `candidate`.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Examiner => "examiner",
            Role::User => "candidate",
        }
    }
}

impl Viewer {
    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }

    pub fn is_examiner(&self) -> bool {
        self.role == Role::Examiner
    }

    /// Examiners and admins may author and run examinations.
    pub fn can_examine(&self) -> bool {
        matches!(self.role, Role::Examiner | Role::Admin)
    }

    pub fn is_candidate(&self) -> bool {
        self.role == Role::User
    }

    pub fn require_examiner(&self) -> Result<(), AppError> {
        if self.can_examine() {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }

    pub fn require_candidate(&self) -> Result<(), AppError> {
        if self.is_candidate() {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }

    pub fn require_admin(&self) -> Result<(), AppError> {
        if self.is_admin() {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }
}

/// Where the token came from, if anywhere. A malformed Authorization header is an error, never a
/// silent fall back to the cookie.
fn token(parts: &Parts, cookie_name: &str) -> Result<Option<(String, bool)>, AppError> {
    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        let value = value.to_str().map_err(|_| AppError::unauthenticated())?;
        let token = value
            .strip_prefix("Bearer ")
            .ok_or_else(AppError::unauthenticated)?;
        return Ok(Some((token.trim().to_owned(), false)));
    }
    Ok(session::read_cookie(&parts.headers, cookie_name).map(|token| (token.to_owned(), true)))
}

async fn resolve(parts: &Parts, state: &AppState) -> Result<Option<Viewer>, AppError> {
    let Some((token, via_cookie)) = token(parts, &state.config.session_cookie)? else {
        return Ok(None);
    };
    let Some(found) = session::lookup(&state.db, &state.config, &token).await? else {
        // A cookie that no longer works is treated as signed out; a bad Bearer token is an error.
        return if via_cookie {
            Ok(None)
        } else {
            Err(AppError::unauthenticated())
        };
    };
    if found.status == "suspended" {
        return Err(AppError::new(
            ErrorCode::AccountSuspended,
            "This account is suspended.",
        ));
    }
    if via_cookie
        && found.renewed
        && let Some(refresh) = parts.extensions.get::<session::CookieRefresh>()
    {
        refresh.queue(session::cookie(
            &state.config,
            &token,
            state.config.session_ttl,
        ));
    }
    let role = if found.role == "admin"
        || state
            .config
            .admin_emails
            .contains(&found.email.to_ascii_lowercase())
    {
        Role::Admin
    } else if found.role == "examiner" {
        Role::Examiner
    } else {
        Role::User
    };
    Ok(Some(Viewer {
        id: found.user_id,
        session_id: found.session_id,
        email: found.email,
        display_name: found.display_name,
        role,
        via_cookie,
    }))
}

impl FromRequestParts<AppState> for Viewer {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(viewer) = parts.extensions.get::<Viewer>() {
            return Ok(viewer.clone());
        }
        let viewer = resolve(parts, state)
            .await?
            .ok_or_else(AppError::unauthenticated)?;
        parts.extensions.insert(viewer.clone());
        Ok(viewer)
    }
}

impl OptionalFromRequestParts<AppState> for Viewer {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Option<Self>, Self::Rejection> {
        if let Some(viewer) = parts.extensions.get::<Viewer>() {
            return Ok(Some(viewer.clone()));
        }
        let viewer = resolve(parts, state).await?;
        if let Some(found) = &viewer {
            parts.extensions.insert(found.clone());
        }
        Ok(viewer)
    }
}

/// `Option<Viewer>` works as an extractor directly; this alias reads better in handler signatures.
pub type MaybeViewer = Option<Viewer>;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::{config::Config, email::LogSender, request::RequestMeta};
    use axum::http::Request;
    use sqlx::PgPool;
    use std::{sync::Arc, time::Duration};

    fn state(db: PgPool) -> AppState {
        let mut config = Config::from_env().unwrap();
        config.session_ttl = Duration::from_secs(3600);
        config.secure_cookies = true;
        AppState {
            db,
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    async fn setup(db: PgPool) -> (AppState, String, Uuid) {
        let state = state(db);
        let id: Uuid = sqlx::query_scalar(
            "insert into users(email) values ('cookie@example.test') returning id",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: "test".into(),
            request_id: "test".into(),
        };
        let (token, id) = session::create(&state.db, &state.config, id, &meta)
            .await
            .unwrap();
        (state, token, id)
    }

    async fn age(state: &AppState, id: Uuid) {
        sqlx::query("update sessions set expires_at = now() + interval '29 minutes' where id = $1")
            .bind(id)
            .execute(&state.db)
            .await
            .unwrap();
    }

    fn parts(state: &AppState, token: &str, bearer: bool, hook: &session::CookieRefresh) -> Parts {
        let (name, value) = if bearer {
            (header::AUTHORIZATION, format!("Bearer {token}"))
        } else {
            (
                header::COOKIE,
                format!("{}={token}", state.config.session_cookie),
            )
        };
        let mut parts = Request::builder()
            .header(name, value)
            .body(())
            .unwrap()
            .into_parts()
            .0;
        parts.extensions.insert(hook.clone());
        parts
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn renewal_and_cookie_hook(db: PgPool) {
        let (state, token, id) = setup(db).await;
        let fresh = session::lookup(&state.db, &state.config, &token)
            .await
            .unwrap()
            .unwrap();
        assert!(!fresh.renewed);
        let hook = session::CookieRefresh::default();
        assert!(
            resolve(&parts(&state, &token, false, &hook), &state)
                .await
                .unwrap()
                .is_some()
        );
        assert!(hook.take().is_none());
        age(&state, id).await;
        assert!(
            resolve(&parts(&state, &token, false, &hook), &state)
                .await
                .unwrap()
                .is_some()
        );
        let value = hook.take().unwrap();
        assert_eq!(
            value,
            session::cookie(&state.config, &token, state.config.session_ttl)
        );
        assert!(hook.take().is_none());
        assert!(!format!("{hook:?}").contains(&token));
        let expires: time::OffsetDateTime =
            sqlx::query_scalar("select expires_at from sessions where id=$1")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(expires > time::OffsetDateTime::now_utc() + time::Duration::minutes(59));
        age(&state, id).await;
        let renewed = session::lookup(&state.db, &state.config, &token)
            .await
            .unwrap()
            .unwrap();
        assert!(renewed.renewed);
        let actual: time::OffsetDateTime =
            sqlx::query_scalar("select expires_at from sessions where id=$1")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(renewed.expires_at, actual);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn bearer_suspended_revoked_and_expired_do_not_queue(db: PgPool) {
        let (state, token, id) = setup(db).await;
        let hook = session::CookieRefresh::default();
        age(&state, id).await;
        assert!(
            resolve(&parts(&state, &token, true, &hook), &state)
                .await
                .unwrap()
                .is_some()
        );
        assert!(hook.take().is_none());
        age(&state, id).await;
        sqlx::query("update users set status='suspended'")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            resolve(&parts(&state, &token, false, &hook), &state)
                .await
                .is_err()
        );
        assert!(hook.take().is_none());
        sqlx::query("update users set status='active'")
            .execute(&state.db)
            .await
            .unwrap();
        session::revoke(&state.db, id).await.unwrap();
        assert!(
            session::lookup(&state.db, &state.config, &token)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            resolve(&parts(&state, &token, false, &hook), &state)
                .await
                .unwrap()
                .is_none()
        );
        sqlx::query("update sessions set revoked_at=null, expires_at=now() - interval '1 second' where id=$1").bind(id).execute(&state.db).await.unwrap();
        assert!(
            session::lookup(&state.db, &state.config, &token)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            resolve(&parts(&state, &token, false, &hook), &state)
                .await
                .unwrap()
                .is_none()
        );
        assert!(hook.take().is_none());
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn concurrent_revocation_cannot_renew(db: PgPool) {
        let (state, token, id) = setup(db).await;
        age(&state, id).await;
        let mut tx = state.db.begin().await.unwrap();
        sqlx::query("update sessions set revoked_at=now() where id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap();
        let cloned = state.clone();
        let task = tokio::spawn(async move {
            session::lookup(&cloned.db, &cloned.config, &token)
                .await
                .unwrap()
        });
        let mut waiting = false;
        for _ in 0..200 {
            waiting = sqlx::query_scalar::<_, bool>("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update sessions set expires_at = $2%')").fetch_one(&state.db).await.unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(waiting, "lookup did not reach the blocked renewal");
        tx.commit().await.unwrap();
        assert!(task.await.unwrap().is_none());
        let revoked: bool = sqlx::query_scalar("select revoked_at is not null and expires_at < now() + interval '30 minutes' from sessions where id=$1").bind(id).fetch_one(&state.db).await.unwrap();
        assert!(revoked);
    }
}
