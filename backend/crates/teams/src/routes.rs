//! HTTP layer. Handlers parse input, apply rate limits, call the service, write the audit log and shape
//! the response. Rules live in `service`; who may act lives in `access`.

use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, get, patch, post},
};
use kernel::{
    AppError, AppResult, AppState,
    email::Email,
    extract::{Json as JsonBody, Path, Query},
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
    viewer::Viewer,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    access::require_role,
    input, mail, page,
    role::TeamRole,
    service::{self, CreatedInvite, InviteRow, MemberRow, TeamView},
};

/// Invites send email, so they're budgeted per sender and per recipient.
const INVITES_PER_USER: Limit = Limit {
    limit: 30,
    window: Duration::from_secs(60 * 60),
};
const INVITES_PER_RECIPIENT: Limit = Limit {
    limit: 5,
    window: Duration::from_secs(24 * 60 * 60),
};
/// Tokens are 256-bit so guessing is hopeless; this still slows down anyone hammering the endpoint.
const ACCEPTS_PER_USER: Limit = Limit {
    limit: 30,
    window: Duration::from_secs(15 * 60),
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/teams", get(list_teams).post(create_team))
        // Literal segment, so it can't be mistaken for a team id.
        .route("/teams/invites/accept", post(accept_invite))
        .route(
            "/teams/{id}",
            get(get_team).patch(rename_team).delete(delete_team),
        )
        .route("/teams/{id}/members", get(list_members))
        .route(
            "/teams/{id}/members/{user_id}",
            patch(set_member_role).delete(remove_member),
        )
        .route("/teams/{id}/invites", get(list_invites).post(create_invite))
        .route("/teams/{id}/invites/{invite_id}", delete(revoke_invite))
        .route("/teams/{id}/transfer", post(transfer))
}

// ------------------------------------------------------------------ bodies and paths

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NameBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoleBody {
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferBody {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InviteBody {
    email: String,
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptBody {
    token: String,
}

// Ids arrive as strings and are checked by hand, so a malformed one is a 404 rather than axum's
// plain-text rejection.
#[derive(Deserialize)]
struct TeamPath {
    id: String,
}

#[derive(Deserialize)]
struct MemberPath {
    id: String,
    user_id: String,
}

#[derive(Deserialize)]
struct InvitePath {
    id: String,
    invite_id: String,
}

// ------------------------------------------------------------------ response shapes

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamDto {
    id: Uuid,
    name: String,
    slug: String,
    /// The caller's own role on the team.
    role: &'static str,
    created_at: String,
    member_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberDto {
    user_id: Uuid,
    display_name: String,
    /// Shown to admins and owners only, so a viewer can't harvest addresses from a team list.
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    role: &'static str,
    joined_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteDto {
    id: Uuid,
    email: String,
    role: &'static str,
    created_at: String,
    expires_at: String,
}

fn rfc3339(at: OffsetDateTime) -> AppResult<String> {
    at.format(&Rfc3339).map_err(AppError::internal)
}

fn team_dto(view: &TeamView) -> AppResult<TeamDto> {
    Ok(TeamDto {
        id: view.id,
        name: view.name.clone(),
        slug: view.slug.clone(),
        role: view.role.as_str(),
        created_at: rfc3339(view.created_at)?,
        member_count: view.member_count,
    })
}

fn member_dto(row: &MemberRow, show_email: bool) -> AppResult<MemberDto> {
    Ok(MemberDto {
        user_id: row.user_id,
        display_name: row.display_name.clone(),
        email: show_email.then(|| row.email.clone()),
        role: row.role()?.as_str(),
        joined_at: rfc3339(row.joined_at)?,
    })
}

fn invite_row_dto(row: &InviteRow) -> AppResult<InviteDto> {
    Ok(InviteDto {
        id: row.id,
        email: row.email.clone(),
        role: row.role()?.as_str(),
        created_at: rfc3339(row.created_at)?,
        expires_at: rfc3339(row.expires_at)?,
    })
}

// ------------------------------------------------------------------ helpers

/// Writes one audit row for a team change. Details hold ids and roles only, never tokens or emails.
async fn record(
    state: &AppState,
    meta: &RequestMeta,
    actor: Uuid,
    action: &str,
    team_id: Uuid,
    details: Value,
) {
    audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("team"),
            target_id: Some(team_id.to_string()),
            meta: details,
        },
    )
    .await;
}

/// The invite email is sent after the response is ready, so a slow mail server never holds up the
/// request. A failure is logged and the invite stays valid; the admin can resend it.
fn send_in_background(state: &AppState, message: Email) {
    let sender = state.email.clone();
    tokio::spawn(async move {
        if let Err(error) = sender.send(&message).await {
            tracing::warn!(error = %error, "team invite email failed");
        }
    });
}

// ------------------------------------------------------------------ teams

async fn list_teams(State(state): State<AppState>, viewer: Viewer) -> AppResult<Json<Value>> {
    let teams = service::list_teams(&state.db, viewer.id).await?;
    let data = teams.iter().map(team_dto).collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "data": data })))
}

async fn create_team(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    JsonBody(body): JsonBody<NameBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let name = input::team_name(&body.name)?;
    let team = service::create_team(&state.db, viewer.id, &name).await?;
    record(&state, &meta, viewer.id, "team.create", team.id, json!({})).await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": team_dto(&team)? })),
    ))
}

async fn get_team(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(path): Path<TeamPath>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let view = service::get_team(&state.db, viewer.id, team).await?;
    Ok(Json(json!({ "data": team_dto(&view)? })))
}

async fn rename_team(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<TeamPath>,
    JsonBody(body): JsonBody<NameBody>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let name = input::team_name(&body.name)?;
    let view = service::rename_team(&state.db, viewer.id, team, &name).await?;
    record(&state, &meta, viewer.id, "team.rename", team, json!({})).await;
    Ok(Json(json!({ "data": team_dto(&view)? })))
}

async fn delete_team(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<TeamPath>,
) -> AppResult<StatusCode> {
    let team = input::uuid_param(&path.id)?;
    service::delete_team(&state.db, viewer.id, team).await?;
    record(&state, &meta, viewer.id, "team.delete", team, json!({})).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn transfer(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<TeamPath>,
    JsonBody(body): JsonBody<TransferBody>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let target = input::uuid_field(&body.user_id, "userId")?;
    let view = service::transfer(&state.db, viewer.id, team, target).await?;
    record(
        &state,
        &meta,
        viewer.id,
        "team.transfer",
        team,
        json!({ "userId": target }),
    )
    .await;
    Ok(Json(json!({ "data": team_dto(&view)? })))
}

// ------------------------------------------------------------------ members

async fn list_members(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(path): Path<TeamPath>,
    Query(query): Query<page::PageQuery>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let role = require_role(&state.db, team, &viewer, TeamRole::Viewer).await?;
    let page = page::parse(query)?;
    let (rows, next) = service::list_members(&state.db, team, &page).await?;
    let show_email = role >= TeamRole::Admin;
    let data = rows
        .iter()
        .map(|row| member_dto(row, show_email))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(
        json!({ "data": data, "meta": { "nextCursor": next } }),
    ))
}

async fn set_member_role(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<MemberPath>,
    JsonBody(body): JsonBody<RoleBody>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let target = input::uuid_param(&path.user_id)?;
    let role = input::member_role(&body.role)?;
    service::set_member_role(&state.db, viewer.id, team, target, role).await?;
    record(
        &state,
        &meta,
        viewer.id,
        "team.member.role",
        team,
        json!({ "userId": target, "role": role.as_str() }),
    )
    .await;
    Ok(Json(
        json!({ "data": { "userId": target, "role": role.as_str() } }),
    ))
}

async fn remove_member(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<MemberPath>,
) -> AppResult<StatusCode> {
    let team = input::uuid_param(&path.id)?;
    let target = input::uuid_param(&path.user_id)?;
    service::remove_member(&state.db, viewer.id, team, target).await?;
    let action = if target == viewer.id {
        "team.member.leave"
    } else {
        "team.member.remove"
    };
    record(
        &state,
        &meta,
        viewer.id,
        action,
        team,
        json!({ "userId": target }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ invites

async fn list_invites(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(path): Path<TeamPath>,
) -> AppResult<Json<Value>> {
    let team = input::uuid_param(&path.id)?;
    let rows = service::list_invites(&state.db, viewer.id, team).await?;
    let data = rows
        .iter()
        .map(invite_row_dto)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "data": data })))
}

async fn create_invite(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<TeamPath>,
    JsonBody(body): JsonBody<InviteBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let team = input::uuid_param(&path.id)?;
    let email = input::email(&body.email)?;
    let role = input::invite_role(&body.role)?;
    enforce_rate_limit(
        &state.db,
        &format!("teams:invite:{}", viewer.id),
        INVITES_PER_USER,
    )
    .await?;
    enforce_rate_limit(
        &state.db,
        &format!("teams:invite-to:{email}"),
        INVITES_PER_RECIPIENT,
    )
    .await?;

    let created: CreatedInvite =
        service::create_invite(&state.db, viewer.id, team, &email, role).await?;
    let link = mail::join_link(&state.config, &created.token);
    let message = mail::invite(
        &mail::app_name(&state.config),
        &mail::Invite {
            to: &created.email,
            team_name: &created.team_name,
            inviter: &viewer.display_name,
            role: created.role,
            link: &link,
        },
    );
    send_in_background(&state, message);

    record(
        &state,
        &meta,
        viewer.id,
        "team.invite.create",
        team,
        json!({ "inviteId": created.id, "role": created.role.as_str() }),
    )
    .await;
    let dto = InviteDto {
        id: created.id,
        email: created.email,
        role: created.role.as_str(),
        created_at: rfc3339(created.created_at)?,
        expires_at: rfc3339(created.expires_at)?,
    };
    Ok((StatusCode::CREATED, Json(json!({ "data": dto }))))
}

async fn revoke_invite(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(path): Path<InvitePath>,
) -> AppResult<StatusCode> {
    let team = input::uuid_param(&path.id)?;
    let invite = input::uuid_param(&path.invite_id)?;
    service::revoke_invite(&state.db, viewer.id, team, invite).await?;
    record(
        &state,
        &meta,
        viewer.id,
        "team.invite.revoke",
        team,
        json!({ "inviteId": invite }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn accept_invite(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    JsonBody(body): JsonBody<AcceptBody>,
) -> AppResult<Json<Value>> {
    enforce_rate_limit(
        &state.db,
        &format!("teams:accept:{}", viewer.id),
        ACCEPTS_PER_USER,
    )
    .await?;
    let token_hash = input::invite_token(&body.token)?;
    let view = service::accept_invite(&state.db, viewer.id, &token_hash).await?;
    record(
        &state,
        &meta,
        viewer.id,
        "team.invite.accept",
        view.id,
        json!({ "role": view.role.as_str() }),
    )
    .await;
    Ok(Json(json!({ "data": team_dto(&view)? })))
}
