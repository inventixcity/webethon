use kernel::{AppError, AppResult, AppState, ErrorCode, Viewer};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Call inside the same transaction as the protected mutation.
pub async fn require_step_up(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    viewer: &Viewer,
) -> AppResult<()> {
    viewer.require_admin()?;
    // The user lock serializes credential and account changes with the mutation.
    let row: Option<(String, String, Option<time::OffsetDateTime>)> = sqlx::query_as(
        "select role,email::text,deleted_at from users where id=$1 and status='active' for update",
    )
    .bind(viewer.id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((role, email, deleted)) = row else {
        return Err(AppError::unauthenticated());
    };
    if deleted.is_some()
        || (role != "admin"
            && !state
                .config
                .admin_emails
                .contains(&email.to_ascii_lowercase()))
    {
        return Err(AppError::forbidden());
    }
    let live: bool = sqlx::query_scalar("select exists(select 1 from sessions where id=$1 and user_id=$2 and revoked_at is null and expires_at>clock_timestamp() for update)").bind(viewer.session_id).bind(viewer.id).fetch_one(&mut **tx).await?;
    if !live {
        return Err(AppError::unauthenticated());
    }
    let valid: bool = sqlx::query_scalar("select exists(select 1 from admin_step_up a join users u on u.id=$2 where a.session_id=$1 and a.expires_at>clock_timestamp() and a.password_changed_at is not distinct from u.password_changed_at and a.password_hash_snapshot=digest(coalesce(u.password_hash,''),'sha256') and a.mfa_snapshot is not distinct from (select digest(secret_ciphertext || secret_nonce || convert_to(enabled_at::text,'UTF8'),'sha256') from mfa_totp where user_id=u.id and enabled_at is not null))").bind(viewer.session_id).bind(viewer.id).fetch_one(&mut **tx).await?;
    if !valid {
        return Err(AppError::new(
            ErrorCode::PreconditionRequired,
            "Please confirm your identity to continue.",
        )
        .with_details(json!({"reason":"STEP_UP_REQUIRED"})));
    }
    Ok(())
}
pub(crate) async fn lock_users_in_order(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    target: Uuid,
) -> AppResult<()> {
    sqlx::query("set local lock_timeout = '2s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("select id from users where id in ($1,$2) order by id for update")
        .bind(actor)
        .bind(target)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db)
                if matches!(db.code().as_deref(), Some("55P03" | "40P01")) =>
            {
                AppError::new(
                    ErrorCode::Unavailable,
                    "Another change is in progress. Please try again.",
                )
                .retry_after(2)
            }
            _ => AppError::from(e),
        })?;
    Ok(())
}
#[allow(dead_code)]
pub(crate) fn reject_self(viewer: &Viewer, target: Uuid) -> AppResult<()> {
    if viewer.id == target {
        return Err(AppError::forbidden());
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use kernel::{config::Config, email::LogSender, viewer::Role};
    use std::sync::Arc;
    #[sqlx::test(migrations = "../../migrations")]
    async fn step_up_is_bound_to_session_and_credentials(db: sqlx::PgPool) {
        let id: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('admin@example.test','admin') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let session: Uuid = sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,decode(repeat('01',32),'hex'),now()+interval '1 hour') returning id").bind(id).fetch_one(&db).await.unwrap();
        let other: Uuid = sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,decode(repeat('02',32),'hex'),now()+interval '1 hour') returning id").bind(id).fetch_one(&db).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let mut viewer = Viewer {
            id,
            session_id: session,
            email: "admin@example.test".into(),
            display_name: String::new(),
            role: Role::Admin,
            via_cookie: false,
        };
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(session).execute(&db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        assert!(
            crate::require_step_up(&mut tx, &state, &viewer)
                .await
                .is_ok()
        );
        tx.rollback().await.unwrap();
        viewer.session_id = other;
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        viewer.session_id = session;
        sqlx::query("update users set password_changed_at=now() where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        sqlx::query("update users set password_changed_at=null where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "update admin_step_up set expires_at=now()-interval '1 second' where session_id=$1",
        )
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        sqlx::query(
            "update admin_step_up set expires_at=now()+interval '10 minutes' where session_id=$1",
        )
        .bind(session)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("insert into mfa_totp(user_id,secret_ciphertext,secret_nonce,enabled_at) values($1,decode('01','hex'),decode('02','hex'),now())").bind(id).execute(&db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        // A flag issued with MFA enabled must become stale on rotation or disablement.
        sqlx::query("update admin_step_up set mfa_snapshot=(select digest(secret_ciphertext || secret_nonce || convert_to(enabled_at::text,'UTF8'),'sha256') from mfa_totp where user_id=$1) where session_id=$2").bind(id).bind(session).execute(&db).await.unwrap();
        sqlx::query("update mfa_totp set secret_ciphertext=decode('03','hex') where user_id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        sqlx::query("update mfa_totp set secret_ciphertext=decode('01','hex'), enabled_at=null where user_id=$1").bind(id).execute(&db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::PreconditionRequired
        );
        tx.rollback().await.unwrap();
        sqlx::query("update sessions set expires_at=now()-interval '1 second' where id=$1")
            .bind(session)
            .execute(&db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Unauthenticated
        );
        tx.rollback().await.unwrap();
        sqlx::query("update sessions set expires_at=now()+interval '1 hour' where id=$1")
            .bind(session)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update sessions set revoked_at=now() where id=$1")
            .bind(session)
            .execute(&db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            require_step_up(&mut tx, &state, &viewer)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Unauthenticated
        );
        tx.rollback().await.unwrap();
        assert!(reject_self(&viewer, id).is_err());
        assert!(reject_self(&viewer, Uuid::new_v4()).is_ok());
    }
}
