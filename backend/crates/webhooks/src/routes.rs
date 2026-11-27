use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    Json, Router,
    extract::{FromRequest, Request, State},
    routing::{get, post},
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer, crypto,
    extract::{Json as Body, Path, Query},
    request::RequestMeta,
    security::{enforce_rate_limit, limits},
};
use rand::{RngCore, rngs::OsRng};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/webhooks", get(list).post(create))
        .route("/webhooks/{id}", get(get_one).patch(update).delete(remove))
        .route("/webhooks/{id}/rotate-secret", post(rotate))
        .route("/webhooks/{id}/deliveries", get(deliveries))
        .route("/webhooks/{id}/test", post(test_delivery))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    url: String,
    events: Vec<String>,
    description: Option<String>,
    team_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    url: Option<String>,
    events: Option<Vec<String>>,
    description: Option<String>,
    active: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    limit: Option<u32>,
    cursor: Option<Uuid>,
}
#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct Hook {
    id: Uuid,
    owner_id: Uuid,
    team_id: Option<Uuid>,
    url: String,
    description: Option<String>,
    events: Vec<String>,
    active: bool,
    failure_since: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}
#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delivery {
    id: Uuid,
    event_id: Uuid,
    status: String,
    response_code: Option<i32>,
    duration_ms: Option<i32>,
    attempt: i32,
    next_retry_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}
const COLUMNS: &str = "id, owner_id, team_id, url, description, events, active, failure_since, created_at, updated_at";
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(ErrorCode::ValidationFailed, "")
        .with_details(json!([{ "path":path, "message":message }]))
}
fn validate(
    url: Option<&str>,
    events: Option<&[String]>,
    desc: Option<&str>,
    production: bool,
) -> AppResult<()> {
    if let Some(url) = url
        && (url.is_empty() || url.len() > 2048 || crate::parse_url(url, production).is_err())
    {
        return Err(invalid("url", "Please enter a valid webhook URL."));
    }
    if let Some(events) = events {
        if events.is_empty() || events.len() > 32 {
            return Err(invalid("events", "Choose between 1 and 32 events."));
        }
        for (i, e) in events.iter().enumerate() {
            if e.len() > 128 || !crate::valid_event(e) {
                return Err(invalid(
                    &format!("events.{i}"),
                    "Please choose a valid event.",
                ));
            }
        }
    }
    if let Some(desc) = desc
        && (desc.len() > 500 || desc.chars().any(char::is_control))
    {
        return Err(invalid("description", "Please enter up to 500 characters."));
    }
    Ok(())
}
fn secret(state: &AppState, id: Uuid) -> AppResult<(String, Vec<u8>)> {
    let (token, _) = crypto::new_token();
    let shown = format!("whsec_{token}");
    let key = crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"webhooks.secret.aes256gcm.v1"],
    );
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(AppError::internal)?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: shown.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| AppError::internal("Webhook encryption failed"))?;
    let mut stored = nonce.to_vec();
    stored.extend(ciphertext);
    Ok((shown, stored))
}
async fn budget(state: &AppState, viewer: &Viewer) -> AppResult<()> {
    enforce_rate_limit(
        &state.db,
        &format!("webhook:write:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    Ok(())
}
async fn access(tx: &mut Transaction<'_, Postgres>, id: Uuid, viewer: &Viewer) -> AppResult<Hook> {
    let hook: Hook = sqlx::query_as(&format!(
        "select {COLUMNS} from webhooks where id=$1 for update"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    if let Some(team) = hook.team_id {
        teams::require_role_tx(tx, team, viewer, teams::TeamRole::Admin)
            .await
            .map_err(|error| {
                if error.code == ErrorCode::Forbidden {
                    AppError::not_found()
                } else {
                    error
                }
            })?;
    } else if hook.owner_id != viewer.id {
        return Err(AppError::not_found());
    }
    Ok(hook)
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    viewer: &Viewer,
    meta: &RequestMeta,
    action: &str,
    id: Uuid,
    before: Option<Value>,
    after: Option<Value>,
) -> AppResult<()> {
    sqlx::query("insert into audit_log(actor_id, action, target_type, target_id, ip, user_agent, request_id, meta) values($1,$2,'webhook',$3,$4,$5,$6,$7)")
        .bind(viewer.id).bind(action).bind(id.to_string()).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({"before":before,"after":after})).execute(&mut **tx).await?;
    Ok(())
}
fn snapshot(h: &Hook) -> Value {
    json!({"id":h.id,"teamId":h.team_id,"active":h.active,"events":h.events})
}
async fn create(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Body(body): Body<Create>,
) -> AppResult<Json<Value>> {
    budget(&state, &viewer).await?;
    validate(
        Some(&body.url),
        Some(&body.events),
        body.description.as_deref(),
        state.config.is_production(),
    )?;
    let mut tx = state.db.begin().await?;
    if let Some(team) = body.team_id {
        teams::require_role_tx(&mut tx, team, &viewer, teams::TeamRole::Admin).await?;
    }
    sqlx::query("select id from users where id=$1 for update")
        .bind(viewer.id)
        .fetch_one(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("select count(*) from webhooks where owner_id=$1")
        .bind(viewer.id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= 10 {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "You can create up to 10 webhooks.",
        ));
    }
    let id = Uuid::new_v4();
    let (shown, encrypted) = secret(&state, id)?;
    let h: Hook=sqlx::query_as(&format!("insert into webhooks(id,owner_id,team_id,url,description,events,secret_ciphertext) values($1,$2,$3,$4,$5,$6,$7) returning {COLUMNS}"))
        .bind(id).bind(viewer.id).bind(body.team_id).bind(body.url).bind(body.description).bind(body.events).bind(encrypted).fetch_one(&mut *tx).await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "webhook.created",
        id,
        None,
        Some(snapshot(&h)),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data": {"webhook":h,"secret":shown}})))
}
async fn get_one(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let h = access(&mut tx, id, &viewer).await?;
    tx.commit().await?;
    Ok(Json(json!({"data":h})))
}
async fn update(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
    req: Request,
) -> AppResult<Json<Value>> {
    budget(&state, &viewer).await?;
    let mut tx = state.db.begin().await?;
    let old = access(&mut tx, id, &viewer).await?;
    let Body(body) = Body::<Update>::from_request(req, &state).await?;
    validate(
        body.url.as_deref(),
        body.events.as_deref(),
        body.description.as_deref(),
        state.config.is_production(),
    )?;
    let h: Hook=sqlx::query_as(&format!("update webhooks set url=coalesce($2,url), events=coalesce($3,events), description=coalesce($4,description), failure_since=case when $5 is true and not active then null else failure_since end, active=coalesce($5,active) where id=$1 returning {COLUMNS}"))
       .bind(id).bind(body.url).bind(body.events).bind(body.description).bind(body.active).fetch_one(&mut *tx).await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "webhook.updated",
        id,
        Some(snapshot(&old)),
        Some(snapshot(&h)),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":h})))
}
async fn remove(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    budget(&state, &viewer).await?;
    let mut tx = state.db.begin().await?;
    let old = access(&mut tx, id, &viewer).await?;
    sqlx::query("delete from webhooks where id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "webhook.deleted",
        id,
        Some(snapshot(&old)),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":{ "deleted":true }})))
}
async fn rotate(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    budget(&state, &viewer).await?;
    let mut tx = state.db.begin().await?;
    let old = access(&mut tx, id, &viewer).await?;
    let (shown, encrypted) = secret(&state, id)?;
    sqlx::query("update webhooks set secret_ciphertext=$2 where id=$1")
        .bind(id)
        .bind(encrypted)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "webhook.secret_rotated",
        id,
        Some(snapshot(&old)),
        Some(snapshot(&old)),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":{"secret":shown}})))
}
async fn list(
    State(state): State<AppState>,
    viewer: Viewer,
    Query(page): Query<Page>,
) -> AppResult<Json<Value>> {
    let limit = page.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Choose a limit from 1 to 100."));
    }
    let rows: Vec<Hook>=sqlx::query_as(&format!("select {COLUMNS} from webhooks w where (w.team_id is null and w.owner_id=$1 or w.team_id in (select m.team_id from team_members m join teams t on t.id=m.team_id where m.user_id=$1 and m.role in ('admin','owner') and t.deleted_at is null)) and ($2::uuid is null or (w.created_at,w.id)<(select c.created_at,c.id from webhooks c where c.id=$2 and (c.team_id is null and c.owner_id=$1 or c.team_id in (select m.team_id from team_members m join teams t on t.id=m.team_id where m.user_id=$1 and m.role in ('admin','owner') and t.deleted_at is null)))) order by w.created_at desc,w.id desc limit $3"))
      .bind(viewer.id).bind(page.cursor).bind(i64::from(limit)+1).fetch_all(&state.db).await?;
    let more = rows.len() > limit as usize;
    let mut rows = rows;
    rows.truncate(limit as usize);
    let cursor = if more {
        rows.last().map(|h| h.id)
    } else {
        None
    };
    Ok(Json(json!({"data":rows,"meta":{"nextCursor":cursor}})))
}
async fn test_delivery(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    budget(&state, &viewer).await?;
    let mut tx = state.db.begin().await?;
    let hook = access(&mut tx, id, &viewer).await?;
    if !hook.active {
        return Err(invalid("webhook", "This webhook is disabled."));
    }
    // access() locks the hook, so simultaneous requests cannot exceed either budget.
    let (recent, pending): (i64, i64) = sqlx::query_as("select count(*) filter (where is_test and created_at > now() - interval '1 minute'), count(*) filter (where status='pending') from webhook_deliveries where webhook_id=$1")
        .bind(id).fetch_one(&mut *tx).await?;
    if recent >= 5 {
        return Err(AppError::new(
            ErrorCode::RateLimited,
            "Too many test deliveries. Please wait a little and try again.",
        )
        .retry_after(60));
    }
    if pending >= 20 {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "This webhook has too many pending deliveries.",
        ));
    }
    let delivery = crate::delivery::enqueue_test(&mut tx, id).await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "webhook.test_queued",
        id,
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":delivery})))
}

async fn deliveries(
    State(state): State<AppState>,
    viewer: Viewer,
    Path(id): Path<Uuid>,
    Query(page): Query<Page>,
) -> AppResult<Json<Value>> {
    let limit = page.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Choose a limit from 1 to 100."));
    }
    let mut tx = state.db.begin().await?;
    access(&mut tx, id, &viewer).await?;
    let mut rows: Vec<Delivery>=sqlx::query_as("select id,event_id,status,response_code,duration_ms,attempt,next_retry_at,created_at,updated_at from webhook_deliveries where webhook_id=$1 and ($2::uuid is null or (created_at,id)<(select created_at,id from webhook_deliveries where id=$2 and webhook_id=$1)) order by created_at desc,id desc limit $3")
      .bind(id).bind(page.cursor).bind(i64::from(limit)+1).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let cursor = if more {
        rows.last().map(|d| d.id)
    } else {
        None
    };
    Ok(Json(json!({"data":rows,"meta":{"nextCursor":cursor}})))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn concurrent_test_requests_obey_per_hook_budget(db: sqlx::PgPool) {
        use std::sync::Arc;
        let owner: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('budget@example.com','Owner') returning id").fetch_one(&db).await.unwrap();
        let hook: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'http://localhost:1',array['*'],decode('00','hex')) returning id").bind(owner).fetch_one(&db).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let viewer = Viewer {
            id: owner,
            session_id: Uuid::new_v4(),
            email: "budget@example.com".into(),
            display_name: "Owner".into(),
            role: kernel::viewer::Role::User,
            via_cookie: false,
        };
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: "budget-test".into(),
        };
        let mut tasks = Vec::new();
        for _ in 0..10 {
            let (state, viewer, meta) = (state.clone(), viewer.clone(), meta.clone());
            tasks.push(tokio::spawn(async move {
                test_delivery(State(state), viewer, meta, Path(hook))
                    .await
                    .map(|_| ())
            }));
        }
        let mut accepted = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(()) => accepted += 1,
                Err(error) => assert_eq!(error.code, ErrorCode::RateLimited),
            }
        }
        assert_eq!(accepted, 5);
        let count: i64 = sqlx::query_scalar(
            "select count(*) from webhook_deliveries where webhook_id=$1 and is_test",
        )
        .bind(hook)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count, 5);
        sqlx::query("update webhook_deliveries set created_at=now()-interval '2 minutes' where webhook_id=$1").bind(hook).execute(&db).await.unwrap();
        sqlx::query("insert into webhook_deliveries(webhook_id,event_id,status) select $1,gen_random_uuid(),'pending' from generate_series(1,15)").bind(hook).execute(&db).await.unwrap();
        let error = test_delivery(State(state), viewer, meta, Path(hook))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::LimitReached);
    }

    #[test]
    fn input_limits_and_event_paths() {
        assert!(
            validate(
                Some("https://example.com"),
                Some(&["record.created:notes".into()]),
                Some("ok"),
                true
            )
            .is_ok()
        );
        assert_eq!(
            validate(Some("http://example.com"), None, None, true)
                .unwrap_err()
                .details
                .unwrap()[0]["path"],
            "url"
        );
        assert_eq!(
            validate(None, Some(&["record.invalid".into()]), None, true)
                .unwrap_err()
                .details
                .unwrap()[0]["path"],
            "events.0"
        );
        assert!(validate(None, Some(&vec!["*".into(); 33]), None, true).is_err());
        assert!(validate(None, None, Some(&"x".repeat(501)), true).is_err());
    }
}
