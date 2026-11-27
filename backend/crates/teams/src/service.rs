//! Team rules and the SQL behind them.
//!
//! Locking rule: every change to a team takes the team row lock first (`for update`), then the invite
//! row, then the user row. Requests for the same team therefore queue up instead of racing, and the
//! order is the same everywhere, so transactions can't deadlock each other.

use kernel::{AppError, AppResult, ErrorCode, crypto, error::is_unique_violation};
use rand::{Rng, rngs::OsRng};
use sqlx::{PgExecutor, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    access::{check, forbidden, require_id, role_in},
    input::failure,
    page::Page,
    role::TeamRole,
};

pub const MAX_TEAMS_PER_USER: i64 = 20;
/// A cap keeps member lists small enough to page and keeps the owner's controls manageable.
pub const MAX_MEMBERS: i64 = 500;
pub const MAX_PENDING_INVITES: i64 = 100;
pub const INVITE_DAYS: i32 = 7;

/// The one error for every invalid invite (unknown, expired, revoked, used). Same wording and code,
/// so a caller can't tell which of those it was.
pub fn invalid_invite() -> AppError {
    AppError::new(
        ErrorCode::NotFound,
        "This invite link isn't valid anymore. Ask the team for a new one.",
    )
}

fn limit(message: &str) -> AppError {
    AppError::new(ErrorCode::LimitReached, message)
}

fn conflict(message: &str) -> AppError {
    AppError::new(ErrorCode::Conflict, message)
}

/// Maps a unique-constraint failure to a retryable conflict. Other database errors stay internal.
fn on_unique(error: sqlx::Error) -> AppError {
    if is_unique_violation(&error) {
        conflict("That changed while you were working. Please try again.")
    } else {
        AppError::from(error)
    }
}

fn parse_role(stored: &str) -> AppResult<TeamRole> {
    TeamRole::parse(stored)
        .ok_or_else(|| AppError::internal(format!("unknown team role {stored:?}")))
}

// ------------------------------------------------------------------ views

#[derive(Clone, Debug)]
pub struct TeamView {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub role: TeamRole,
    pub created_at: OffsetDateTime,
    pub member_count: i64,
}

#[derive(sqlx::FromRow)]
struct TeamRow {
    id: Uuid,
    name: String,
    slug: String,
    role: String,
    created_at: OffsetDateTime,
    member_count: i64,
}

impl TryFrom<TeamRow> for TeamView {
    type Error = AppError;

    fn try_from(row: TeamRow) -> AppResult<Self> {
        Ok(Self {
            id: row.id,
            name: row.name,
            slug: row.slug,
            role: parse_role(&row.role)?,
            created_at: row.created_at,
            member_count: row.member_count,
        })
    }
}

const TEAM_VIEW: &str = "select t.id, t.name, t.slug, m.role, t.created_at,
    (select count(*) from team_members c where c.team_id = t.id) as member_count
    from teams t join team_members m on m.team_id = t.id
    join users u on u.id = m.user_id
    where t.deleted_at is null and u.deleted_at is null";

async fn team_view(db: &PgPool, team_id: Uuid, user_id: Uuid) -> AppResult<TeamView> {
    let row: Option<TeamRow> =
        sqlx::query_as(&format!("{TEAM_VIEW} and t.id = $1 and m.user_id = $2"))
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    row.ok_or_else(AppError::not_found)?.try_into()
}

pub async fn list_teams(db: &PgPool, user_id: Uuid) -> AppResult<Vec<TeamView>> {
    let rows: Vec<TeamRow> = sqlx::query_as(&format!(
        "{TEAM_VIEW} and m.user_id = $1 order by t.created_at, t.id"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?;
    rows.into_iter().map(TeamView::try_from).collect()
}

pub async fn get_team(db: &PgPool, user_id: Uuid, team_id: Uuid) -> AppResult<TeamView> {
    team_view(db, team_id, user_id).await
}

#[derive(sqlx::FromRow)]
pub struct MemberRow {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
    role: String,
    pub joined_at: OffsetDateTime,
}

impl MemberRow {
    pub fn role(&self) -> AppResult<TeamRole> {
        parse_role(&self.role)
    }
}

#[derive(sqlx::FromRow)]
pub struct InviteRow {
    pub id: Uuid,
    pub email: String,
    role: String,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

impl InviteRow {
    pub fn role(&self) -> AppResult<TeamRole> {
        parse_role(&self.role)
    }
}

// ------------------------------------------------------------------ locking helpers

/// Locks the live team row and returns its name. A deleted or missing team is a 404.
async fn lock_team(tx: &mut Transaction<'_, Postgres>, team_id: Uuid) -> AppResult<String> {
    let name: Option<String> = sqlx::query_scalar(
        "select name from teams where id = $1 and deleted_at is null for update",
    )
    .bind(team_id)
    .fetch_optional(&mut **tx)
    .await?;
    name.ok_or_else(AppError::not_found)
}

/// Locks the user row. Used when a check counts a user's teams, so two joins can't both pass the cap.
async fn lock_user(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> AppResult<()> {
    sqlx::query("select id from users where id = $1 for update")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Locks the team, then checks the caller's role. Returns the team name and the caller's role.
async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    team_id: Uuid,
    user_id: Uuid,
    min: TeamRole,
) -> AppResult<(String, TeamRole)> {
    let name = lock_team(tx, team_id).await?;
    let role = role_in(&mut **tx, team_id, user_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok((name, check(role, min)?))
}

async fn count_teams<'e>(executor: impl PgExecutor<'e>, user_id: Uuid) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "select count(*) from team_members m join teams t on t.id = m.team_id
         where m.user_id = $1 and t.deleted_at is null",
    )
    .bind(user_id)
    .fetch_one(executor)
    .await?)
}

async fn count_members<'e>(executor: impl PgExecutor<'e>, team_id: Uuid) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar("select count(*) from team_members where team_id = $1")
            .bind(team_id)
            .fetch_one(executor)
            .await?,
    )
}

// ------------------------------------------------------------------ teams

/// A readable slug plus eight random characters, so two teams with the same name never collide.
/// The slug is fixed at creation; renaming changes only the display name.
pub fn slug_for(name: &str) -> String {
    let mut base = String::new();
    for character in name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            base.push(character);
        } else if !base.is_empty() && !base.ends_with('-') {
            base.push('-');
        }
    }
    let base: String = base.trim_end_matches('-').chars().take(40).collect();
    let base = if base.is_empty() {
        "team".to_owned()
    } else {
        base
    };
    let suffix: String = (0..8)
        .map(|_| char::from(b'a' + OsRng.gen_range(0..26u8)))
        .collect();
    format!("{base}-{suffix}")
}

pub async fn create_team(db: &PgPool, user_id: Uuid, name: &str) -> AppResult<TeamView> {
    let mut tx = db.begin().await?;
    lock_user(&mut tx, user_id).await?;
    if count_teams(&mut *tx, user_id).await? >= MAX_TEAMS_PER_USER {
        return Err(limit(
            "You can be on at most 20 teams. Leave one to create another.",
        ));
    }
    let slug = slug_for(name);
    let (id, created_at): (Uuid, OffsetDateTime) = sqlx::query_as(
        "insert into teams (name, slug, created_by) values ($1, $2, $3) returning id, created_at",
    )
    .bind(name)
    .bind(&slug)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(on_unique)?;
    sqlx::query("insert into team_members (team_id, user_id, role) values ($1, $2, 'owner')")
        .bind(id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(TeamView {
        id,
        name: name.to_owned(),
        slug,
        role: TeamRole::Owner,
        created_at,
        member_count: 1,
    })
}

pub async fn rename_team(
    db: &PgPool,
    user_id: Uuid,
    team_id: Uuid,
    name: &str,
) -> AppResult<TeamView> {
    let mut tx = db.begin().await?;
    authorize(&mut tx, team_id, user_id, TeamRole::Admin).await?;
    sqlx::query("update teams set name = $2 where id = $1")
        .bind(team_id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    team_view(db, team_id, user_id).await
}

/// Soft-deletes the team and revokes its open invites. The owner can always do this. An admin can
/// too, but only when the owner's account has been deleted, so the team can't be left stranded.
pub async fn delete_team(db: &PgPool, user_id: Uuid, team_id: Uuid) -> AppResult<()> {
    let mut tx = db.begin().await?;
    lock_team(&mut tx, team_id).await?;
    let role = role_in(&mut *tx, team_id, user_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    let owner_active = active_owner_exists(&mut *tx, team_id).await?;
    if role != TeamRole::Owner && !(role == TeamRole::Admin && !owner_active) {
        return Err(forbidden("Only the team owner can delete this team."));
    }
    sqlx::query("update teams set deleted_at = now() where id = $1")
        .bind(team_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "update team_invites set revoked_at = now()
         where team_id = $1 and accepted_at is null and revoked_at is null",
    )
    .bind(team_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn active_owner_exists<'e>(executor: impl PgExecutor<'e>, team_id: Uuid) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "select exists(select 1 from team_members m join users u on u.id = m.user_id
         where m.team_id = $1 and m.role = 'owner' and u.deleted_at is null)",
    )
    .bind(team_id)
    .fetch_one(executor)
    .await?)
}

// ------------------------------------------------------------------ members

pub async fn list_members(
    db: &PgPool,
    team_id: Uuid,
    page: &Page,
) -> AppResult<(Vec<MemberRow>, Option<String>)> {
    let after_at = page.after.map(|(at, _)| at);
    let after_id = page.after.map(|(_, id)| id);
    let mut rows: Vec<MemberRow> = sqlx::query_as(
        "select m.user_id, u.display_name, u.email::text as email, m.role, m.joined_at
         from team_members m join users u on u.id = m.user_id
         where m.team_id = $1 and u.deleted_at is null
           and ($2::timestamptz is null or (m.joined_at, m.user_id) > ($2::timestamptz, $3::uuid))
         order by m.joined_at, m.user_id
         limit $4",
    )
    .bind(team_id)
    .bind(after_at)
    .bind(after_id)
    .bind(page.limit + 1)
    .fetch_all(db)
    .await?;

    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > page.limit;
    rows.truncate(usize::try_from(page.limit).unwrap_or(usize::MAX));
    let next = match (has_more, rows.last()) {
        (true, Some(last)) => Some(crate::page::encode(last.joined_at, last.user_id)?),
        _ => None,
    };
    Ok((rows, next))
}

/// Changes a member's role. Admins can manage only roles below their own, and they can't touch the
/// owner, who moves only through transfer.
pub async fn set_member_role(
    db: &PgPool,
    actor_id: Uuid,
    team_id: Uuid,
    target_id: Uuid,
    new_role: TeamRole,
) -> AppResult<()> {
    let mut tx = db.begin().await?;
    let (_, actor_role) = authorize(&mut tx, team_id, actor_id, TeamRole::Admin).await?;
    let target_role = role_in(&mut *tx, team_id, target_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if target_role == TeamRole::Owner {
        return Err(forbidden(
            "The owner's role can't be changed. Transfer ownership first.",
        ));
    }
    if target_role > actor_role {
        return Err(forbidden(
            "You can't change someone with a higher role than yours.",
        ));
    }
    if new_role > actor_role {
        return Err(forbidden("You can't give a role higher than your own."));
    }
    sqlx::query("update team_members set role = $3 where team_id = $1 and user_id = $2")
        .bind(team_id)
        .bind(target_id)
        .bind(new_role.as_str())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Removes a member, or lets someone leave when `target_id` is their own id. Owners can't leave or
/// be removed; they transfer ownership first. That keeps every team with an owner.
pub async fn remove_member(
    db: &PgPool,
    actor_id: Uuid,
    team_id: Uuid,
    target_id: Uuid,
) -> AppResult<()> {
    let mut tx = db.begin().await?;
    if actor_id == target_id {
        let (_, role) = authorize(&mut tx, team_id, actor_id, TeamRole::Viewer).await?;
        if role == TeamRole::Owner {
            return Err(conflict(
                "Owners can't leave yet. Transfer ownership first.",
            ));
        }
    } else {
        let (_, actor_role) = authorize(&mut tx, team_id, actor_id, TeamRole::Admin).await?;
        let target_role = role_in(&mut *tx, team_id, target_id)
            .await?
            .ok_or_else(AppError::not_found)?;
        if target_role == TeamRole::Owner {
            return Err(forbidden(
                "The owner can't be removed. Transfer ownership first.",
            ));
        }
        if target_role > actor_role {
            return Err(forbidden(
                "You can't remove someone with a higher role than yours.",
            ));
        }
    }
    sqlx::query("delete from team_members where team_id = $1 and user_id = $2")
        .bind(team_id)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Hands ownership to another member. The caller becomes an admin in the same transaction, so there
/// is always exactly one owner.
pub async fn transfer(
    db: &PgPool,
    actor_id: Uuid,
    team_id: Uuid,
    target_id: Uuid,
) -> AppResult<TeamView> {
    if actor_id == target_id {
        return Err(failure("userId", "Pick another member to take over."));
    }
    let mut tx = db.begin().await?;
    authorize(&mut tx, team_id, actor_id, TeamRole::Owner).await?;
    role_in(&mut *tx, team_id, target_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    sqlx::query("update team_members set role = 'admin' where team_id = $1 and user_id = $2")
        .bind(team_id)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("update team_members set role = 'owner' where team_id = $1 and user_id = $2")
        .bind(team_id)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    team_view(db, team_id, actor_id).await
}

// ------------------------------------------------------------------ invites

pub struct CreatedInvite {
    pub id: Uuid,
    pub email: String,
    pub role: TeamRole,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    /// Only ever returned here, to be put in the email. It's never stored or shown again.
    pub token: String,
    pub team_name: String,
}

/// Creates an invite and returns its token. Inviting an address that already has a pending invite
/// replaces that invite, so only the newest link works.
pub async fn create_invite(
    db: &PgPool,
    actor_id: Uuid,
    team_id: Uuid,
    email: &str,
    role: TeamRole,
) -> AppResult<CreatedInvite> {
    let mut tx = db.begin().await?;
    let (team_name, actor_role) = authorize(&mut tx, team_id, actor_id, TeamRole::Admin).await?;
    if role > actor_role {
        return Err(forbidden(
            "You can't invite someone to a role higher than yours.",
        ));
    }
    let already_member: bool = sqlx::query_scalar(
        "select exists(select 1 from team_members m join users u on u.id = m.user_id
         where m.team_id = $1 and u.email = $2::citext and u.deleted_at is null)",
    )
    .bind(team_id)
    .bind(email)
    .fetch_one(&mut *tx)
    .await?;
    if already_member {
        return Err(conflict("That person is already on this team."));
    }
    let pending: i64 = sqlx::query_scalar(
        "select count(*) from team_invites
         where team_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()",
    )
    .bind(team_id)
    .fetch_one(&mut *tx)
    .await?;
    if pending >= MAX_PENDING_INVITES {
        return Err(limit(
            "This team has too many pending invites. Revoke some first.",
        ));
    }
    sqlx::query(
        "update team_invites set revoked_at = now()
         where team_id = $1 and email = $2::citext and accepted_at is null and revoked_at is null",
    )
    .bind(team_id)
    .bind(email)
    .execute(&mut *tx)
    .await?;

    let (token, hash) = crypto::new_token();
    let (id, created_at, expires_at): (Uuid, OffsetDateTime, OffsetDateTime) = sqlx::query_as(
        "insert into team_invites (team_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2::citext, $3, $4, $5, now() + make_interval(days => $6))
         returning id, created_at, expires_at",
    )
    .bind(team_id)
    .bind(email)
    .bind(role.as_str())
    .bind(hash.as_slice())
    .bind(actor_id)
    .bind(INVITE_DAYS)
    .fetch_one(&mut *tx)
    .await
    .map_err(on_unique)?;
    tx.commit().await?;
    Ok(CreatedInvite {
        id,
        email: email.to_owned(),
        role,
        created_at,
        expires_at,
        token,
        team_name,
    })
}

pub async fn list_invites(db: &PgPool, actor_id: Uuid, team_id: Uuid) -> AppResult<Vec<InviteRow>> {
    require_id(db, team_id, actor_id, TeamRole::Admin).await?;
    Ok(sqlx::query_as(
        "select id, email::text as email, role, created_at, expires_at from team_invites
         where team_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
         order by created_at desc, id desc",
    )
    .bind(team_id)
    .fetch_all(db)
    .await?)
}

pub async fn revoke_invite(
    db: &PgPool,
    actor_id: Uuid,
    team_id: Uuid,
    invite_id: Uuid,
) -> AppResult<()> {
    let mut tx = db.begin().await?;
    let (_, actor_role) = authorize(&mut tx, team_id, actor_id, TeamRole::Admin).await?;
    let stored: Option<String> = sqlx::query_scalar(
        "select role from team_invites
         where id = $1 and team_id = $2 and accepted_at is null and revoked_at is null
         for update",
    )
    .bind(invite_id)
    .bind(team_id)
    .fetch_optional(&mut *tx)
    .await?;
    let invite_role = parse_role(&stored.ok_or_else(AppError::not_found)?)?;
    if invite_role > actor_role {
        return Err(forbidden(
            "You can't revoke an invite for a role higher than yours.",
        ));
    }
    sqlx::query("update team_invites set revoked_at = now() where id = $1")
        .bind(invite_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct InviteLock {
    team_id: Uuid,
    email: String,
    role: String,
    accepted: bool,
    revoked: bool,
    expired: bool,
}

/// Accepts an invite for the signed-in user. The invite must be open, unexpired and unused; the
/// signed-in account must have a verified email equal to the invite's (case-insensitive).
pub async fn accept_invite(
    db: &PgPool,
    user_id: Uuid,
    token_hash: &[u8; 32],
) -> AppResult<TeamView> {
    let team_id: Option<Uuid> =
        sqlx::query_scalar("select team_id from team_invites where token_hash = $1")
            .bind(token_hash.as_slice())
            .fetch_optional(db)
            .await?;
    let team_id = team_id.ok_or_else(invalid_invite)?;

    let mut tx = db.begin().await?;
    // Only a missing or deleted team means "invalid invite"; a database failure must stay internal.
    lock_team(&mut tx, team_id).await.map_err(|error| {
        if error.code == ErrorCode::NotFound {
            invalid_invite()
        } else {
            error
        }
    })?;
    let invite: InviteLock = sqlx::query_as(
        "select team_id, email::text as email, role,
            accepted_at is not null as accepted, revoked_at is not null as revoked,
            expires_at <= now() as expired
         from team_invites where token_hash = $1 for update",
    )
    .bind(token_hash.as_slice())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(invalid_invite)?;
    if invite.team_id != team_id || invite.accepted || invite.revoked || invite.expired {
        return Err(invalid_invite());
    }

    lock_user(&mut tx, user_id).await?;
    let (account_email, verified): (String, bool) = sqlx::query_as(
        "select email::text as email, email_verified_at is not null as verified
         from users where id = $1 and deleted_at is null",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::unauthenticated)?;
    if !verified {
        return Err(AppError::new(
            ErrorCode::EmailNotVerified,
            "Verify your email before accepting an invite.",
        ));
    }
    if !account_email.eq_ignore_ascii_case(&invite.email) {
        return Err(forbidden(
            "This invite was sent to a different email address. Sign in with that address to join.",
        ));
    }

    // Someone already on the team keeps their current role, so accepting can't demote them.
    if role_in(&mut *tx, team_id, user_id).await?.is_none() {
        if count_members(&mut *tx, team_id).await? >= MAX_MEMBERS {
            return Err(limit("This team is full."));
        }
        if count_teams(&mut *tx, user_id).await? >= MAX_TEAMS_PER_USER {
            return Err(limit(
                "You can be on at most 20 teams. Leave one to join another.",
            ));
        }
        let role = parse_role(&invite.role)?;
        sqlx::query("insert into team_members (team_id, user_id, role) values ($1, $2, $3)")
            .bind(team_id)
            .bind(user_id)
            .bind(role.as_str())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("update team_invites set accepted_at = now() where token_hash = $1")
        .bind(token_hash.as_slice())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    team_view(db, team_id, user_id).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_url_safe_and_unique_per_call() {
        let first = slug_for("Night Owls!! ✨");
        let second = slug_for("Night Owls!! ✨");
        assert!(first.starts_with("night-owls-"), "{first}");
        assert_ne!(first, second);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        );
    }

    #[test]
    fn non_latin_names_get_a_fallback_slug() {
        assert!(slug_for("日本語").starts_with("team-"));
        assert!(slug_for("   ").starts_with("team-"));
        assert!(slug_for(&"a".repeat(200)).len() <= 40 + 1 + 8);
    }
}
