//! Who may do what on a team. Every team route checks membership and role here before doing anything
//! else. Non-members get 404 so a team's existence isn't revealed; members without enough role get 403.

use kernel::{AppError, AppResult, ErrorCode, Viewer};
use sqlx::{PgExecutor, PgPool};
use uuid::Uuid;

use crate::role::TeamRole;

/// The caller's role on a live team, or None for non-members, removed members, deleted teams and
/// deleted accounts. Those four cases must look identical to the caller.
pub async fn role_of(db: &PgPool, team_id: Uuid, user_id: Uuid) -> AppResult<Option<TeamRole>> {
    role_in(db, team_id, user_id).await
}

/// Same as `role_of`, usable inside a transaction.
pub(crate) async fn role_in<'e>(
    executor: impl PgExecutor<'e>,
    team_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<TeamRole>> {
    let stored: Option<String> = sqlx::query_scalar(
        "select m.role from team_members m
         join teams t on t.id = m.team_id
         join users u on u.id = m.user_id
         where m.team_id = $1 and m.user_id = $2 and t.deleted_at is null and u.deleted_at is null",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_optional(executor)
    .await?;
    Ok(stored.as_deref().and_then(TeamRole::parse))
}

/// Returns the caller's role when it is at least `min`.
///
/// Non-members get 404 (the same as a team that doesn't exist). Members with too little role get 403.
pub async fn require_role(
    db: &PgPool,
    team_id: Uuid,
    viewer: &Viewer,
    min: TeamRole,
) -> AppResult<TeamRole> {
    require_id(db, team_id, viewer.id, min).await
}

/// `require_role` for callers that have a user id rather than a `Viewer`.
pub(crate) async fn require_id(
    db: &PgPool,
    team_id: Uuid,
    user_id: Uuid,
    min: TeamRole,
) -> AppResult<TeamRole> {
    let role = role_of(db, team_id, user_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    check(role, min)
}

/// Check and lock the live team and membership for a mutation transaction.
/// Locks serialize the mutation with membership removal and team deletion.
pub async fn require_role_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Uuid,
    viewer: &Viewer,
    min: TeamRole,
) -> AppResult<TeamRole> {
    let stored: Option<String> = sqlx::query_scalar(
        "select m.role from teams t join team_members m on m.team_id=t.id join users u on u.id=m.user_id where t.id=$1 and m.user_id=$2 and t.deleted_at is null and u.deleted_at is null for update of t, m, u",
    ).bind(team_id).bind(viewer.id).fetch_optional(&mut **tx).await?;
    let role = stored
        .as_deref()
        .and_then(TeamRole::parse)
        .ok_or_else(AppError::not_found)?;
    check(role, min)
}

/// Passes the role through when it is enough, otherwise a 403 that says what was refused.
pub(crate) fn check(role: TeamRole, min: TeamRole) -> AppResult<TeamRole> {
    if role >= min {
        Ok(role)
    } else {
        Err(forbidden("Your role on this team doesn't allow that."))
    }
}

pub(crate) fn forbidden(message: &str) -> AppError {
    AppError::new(ErrorCode::Forbidden, message)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn check_allows_equal_or_higher_roles_only() {
        assert!(check(TeamRole::Admin, TeamRole::Admin).is_ok());
        assert!(check(TeamRole::Owner, TeamRole::Admin).is_ok());
        assert!(check(TeamRole::Member, TeamRole::Admin).is_err());
        assert!(check(TeamRole::Viewer, TeamRole::Member).is_err());
        let error = check(TeamRole::Viewer, TeamRole::Owner).unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);
    }
}
