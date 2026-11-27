use axum::{
    Extension, Router,
    extract::{Request, State},
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, crypto,
    extract::{Json, Path, Query},
    request::RequestMeta,
    security::{self, limits},
    viewer::Viewer,
};
use records::EntityRegistry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod security_tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    entity: String,
    record_id: Uuid,
    expires_in_days: Option<i32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    limit: Option<i64>,
    cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    v: String,
    id: Uuid,
    s: String,
    viewer: Uuid,
}

fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path, "message": message }]))
}
fn date(value: OffsetDateTime) -> AppResult<String> {
    value.format(&Rfc3339).map_err(AppError::internal)
}
fn parse_cursor(value: &str, viewer: Uuid) -> AppResult<(OffsetDateTime, Uuid)> {
    if value.len() > 1024 {
        return Err(AppError::bad_request("Invalid cursor."));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::bad_request("Invalid cursor."))?;
    let c: Cursor =
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad_request("Invalid cursor."))?;
    if c.s != "shares:list:-createdAt" || c.viewer != viewer {
        return Err(AppError::bad_request("Invalid cursor."));
    }
    Ok((
        OffsetDateTime::parse(&c.v, &Rfc3339)
            .map_err(|_| AppError::bad_request("Invalid cursor."))?,
        c.id,
    ))
}
async fn write_limit(state: &AppState, viewer: &Viewer, meta: &RequestMeta) -> AppResult<()> {
    security::enforce_rate_limit(
        &state.db,
        &format!("shares:write:user:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("shares:write:ip:{}", meta.ip),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    Ok(())
}
async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    meta: &RequestMeta,
    actor: Uuid,
    action: &str,
    id: Uuid,
) -> AppResult<()> {
    sqlx::query("insert into audit_log(actor_id,action,target_type,target_id,ip,user_agent,request_id,meta) values($1,$2,'share',$3,$4,$5,$6,$7)")
        .bind(actor).bind(action).bind(id.to_string()).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({}))
        .execute(&mut **tx).await?;
    Ok(())
}
async fn create(
    State(state): State<AppState>,
    Extension(registry): Extension<Arc<EntityRegistry>>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<Create>,
) -> AppResult<Json<Value>> {
    write_limit(&state, &viewer, &meta).await?;
    let mut chars = input.entity.bytes();
    if input.entity.len() > 48
        || !chars.next().is_some_and(|c| c.is_ascii_lowercase())
        || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(invalid("entity", "Enter a valid entity."));
    }
    registry.definition(&input.entity)?;
    let days = input.expires_in_days.unwrap_or(30);
    if !(1..=90).contains(&days) {
        return Err(invalid("expiresInDays", "Choose between 1 and 90 days."));
    }
    let (token, hash) = crypto::new_token();
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, OffsetDateTime)> = sqlx::query_as("insert into shares(record_id,creator_id,token_hash,expires_at) select r.id,$3,$4,now()+make_interval(days => $5) from records r join users u on u.id=r.owner_id join users c on c.id=$3 where r.id=$1 and r.entity=$2 and r.deleted_at is null and r.admin_hidden_at is null and u.deleted_at is null and u.status='active' and c.deleted_at is null and c.status='active' and ((r.team_id is null and r.owner_id=$3) or (r.team_id is not null and exists(select 1 from teams t join team_members m on m.team_id=t.id where t.id=r.team_id and t.deleted_at is null and m.user_id=$3 and m.role in ('owner','admin')))) returning id,expires_at")
        .bind(input.record_id).bind(&input.entity).bind(viewer.id).bind(hash.as_slice()).bind(days).fetch_optional(&mut *tx).await?;
    let (id, expires) = row.ok_or_else(AppError::not_found)?;
    audit(&mut tx, &meta, viewer.id, "share.created", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"data":{"id":id,"url":format!("{}/s/{}", state.config.app_origin.trim_end_matches('/'), token),"expiresAt":date(expires)?}}),
    ))
}
async fn list(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Query(query): Query<List>,
) -> AppResult<Json<Value>> {
    security::enforce_rate_limit(
        &state.db,
        &format!("shares:list:ip:{}", meta.ip),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Choose between 1 and 100."));
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(|c| parse_cursor(c, viewer.id))
        .transpose()?;
    let rows: Vec<(Uuid, Uuid, String, OffsetDateTime, OffsetDateTime)> = sqlx::query_as("select s.id,s.record_id,r.entity,s.created_at,s.expires_at from shares s join records r on r.id=s.record_id where s.creator_id=$1 and s.revoked_at is null and ($2::timestamptz is null or (s.created_at,s.id)<($2,$3)) order by s.created_at desc,s.id desc limit $4")
        .bind(viewer.id).bind(cursor.map(|c| c.0)).bind(cursor.map(|c| c.1)).bind(limit+1).fetch_all(&state.db).await?;
    let more = rows.len() > limit as usize;
    let mut items = Vec::new();
    let mut next = None;
    for (id, record_id, entity, created, expires) in rows.into_iter().take(limit as usize) {
        next = Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    v: date(created)?,
                    id,
                    s: "shares:list:-createdAt".into(),
                    viewer: viewer.id,
                })
                .map_err(AppError::internal)?,
            ),
        );
        items.push(json!({"id":id,"recordId":record_id,"entity":entity,"createdAt":date(created)?,"expiresAt":date(expires)?}));
    }
    Ok(Json(
        json!({"data":items,"meta":{"nextCursor":if more {next} else {None}}}),
    ))
}
async fn revoke(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    write_limit(&state, &viewer, &meta).await?;
    let mut tx = state.db.begin().await?;
    let result = sqlx::query(
        "update shares set revoked_at=now() where id=$1 and creator_id=$2 and revoked_at is null",
    )
    .bind(id)
    .bind(viewer.id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit(&mut tx, &meta, viewer.id, "share.revoked", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"data":{"id":id}})))
}
async fn public(
    State(state): State<AppState>,
    Extension(registry): Extension<Arc<EntityRegistry>>,
    meta: RequestMeta,
    Path(token): Path<String>,
) -> AppResult<Json<Value>> {
    security::enforce_rate_limit(
        &state.db,
        &format!("shares:public:ip:{}", meta.ip),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let hash = crypto::hash_token(&token).ok_or_else(AppError::not_found)?;
    let row: Option<(Uuid, Value, Vec<u8>, String)> = sqlx::query_as("select r.id,r.data,s.token_hash,r.entity from shares s join records r on r.id=s.record_id join users u on u.id=r.owner_id join users c on c.id=s.creator_id where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and r.deleted_at is null and r.admin_hidden_at is null and u.deleted_at is null and u.status='active' and c.deleted_at is null and c.status='active' and ((r.team_id is null and r.owner_id=s.creator_id) or (r.team_id is not null and exists(select 1 from teams t join team_members m on m.team_id=t.id where t.id=r.team_id and t.deleted_at is null and m.user_id=s.creator_id and m.role in ('owner','admin'))))")
        .bind(hash.as_slice()).fetch_optional(&state.db).await?;
    let (id, data, stored, entity) = row.ok_or_else(AppError::not_found)?;
    registry.definition(&entity)?;
    if !crypto::constant_time_eq(&hash, &stored) {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({"data":{"id":id,"data":data}})))
}
async fn public_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("x-robots-tag", HeaderValue::from_static("noindex"));
    response
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/shares", post(create).get(list))
        .route("/shares/{id}", axum::routing::delete(revoke))
        .merge(
            Router::new()
                .route("/public/shares/{token}", get(public))
                .layer(middleware::from_fn(public_headers)),
        )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn cursor_rejects_invalid_and_round_trips() {
        let id = Uuid::new_v4();
        let c = Cursor {
            v: "2026-11-23T00:00:00Z".into(),
            id,
            s: "shares:list:-createdAt".into(),
            viewer: id,
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap());
        assert_eq!(parse_cursor(&encoded, id).unwrap().1, id);
        assert!(parse_cursor(&"x".repeat(1025), id).is_err());
        assert!(parse_cursor("garbage", id).is_err());
        assert!(parse_cursor(&encoded, Uuid::new_v4()).is_err());
    }
    #[test]
    fn generated_tokens_are_distinct_and_hashed() {
        let (a, hash) = crypto::new_token();
        let (b, _) = crypto::new_token();
        assert_ne!(a, b);
        assert_eq!(crypto::hash_token(&a), Some(hash));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod integration_tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use kernel::{config::Config, email::LogSender, viewer::Role};
    use sqlx::PgPool;
    use std::sync::Arc;
    use tower::ServiceExt;

    #[sqlx::test(migrations = "../../migrations")]
    async fn private_shares_follow_authority_and_moderation(db: PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config,
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let owner: Uuid = sqlx::query_scalar("insert into users(email) values ($1) returning id")
            .bind(format!("{}@example.com", Uuid::new_v4()))
            .fetch_one(&db)
            .await
            .unwrap();
        let other: Uuid = sqlx::query_scalar("insert into users(email) values ($1) returning id")
            .bind(format!("{}@example.com", Uuid::new_v4()))
            .fetch_one(&db)
            .await
            .unwrap();
        let record: Uuid = sqlx::query_scalar(
            "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
        )
        .bind(owner)
        .bind(json!({"title":"private"}))
        .fetch_one(&db)
        .await
        .unwrap();
        let viewer = |id| Viewer {
            id,
            session_id: Uuid::new_v4(),
            email: String::new(),
            display_name: String::new(),
            role: Role::User,
            via_cookie: false,
        };
        let meta = || RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let registry = Arc::new(EntityRegistry::from_json(&json!({"notes":{"label":"Notes","read":"owner","create":"authenticated","write":"owner","allowPublic":false,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"title":{"type":"string","maxLength":100}},"required":["title"]}}}).to_string()).unwrap());
        let input = || Create {
            entity: "notes".into(),
            record_id: record,
            expires_in_days: None,
        };
        assert_eq!(
            create(
                State(state.clone()),
                Extension(registry.clone()),
                viewer(other),
                meta(),
                Json(input())
            )
            .await
            .err()
            .unwrap()
            .code,
            ErrorCode::NotFound
        );
        let Json(created) = create(
            State(state.clone()),
            Extension(registry.clone()),
            viewer(owner),
            meta(),
            Json(input()),
        )
        .await
        .unwrap();
        let token = created["data"]["url"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        let app = router()
            .layer(Extension(registry))
            .with_state(state.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/public/shares/{token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-robots-tag"], "noindex");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(body["data"]["data"]["title"], "private");
        assert!(body["data"].get("ownerId").is_none());
        sqlx::query("update records set admin_hidden_at=now() where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/public/shares/{token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-robots-tag"], "noindex");

        let share_id = Uuid::parse_str(created["data"]["id"].as_str().unwrap()).unwrap();
        // Revocation remains available even when the underlying record is hidden.
        assert!(
            revoke(State(state.clone()), viewer(other), meta(), Path(share_id))
                .await
                .is_err()
        );
        revoke(State(state.clone()), viewer(owner), meta(), Path(share_id))
            .await
            .unwrap();
        let Json(listed) = list(
            State(state.clone()),
            viewer(owner),
            meta(),
            Query(List {
                limit: None,
                cursor: None,
            }),
        )
        .await
        .unwrap();
        assert!(listed["data"].as_array().unwrap().is_empty());
        let audits: i64 = sqlx::query_scalar("select count(*) from audit_log where target_id=$1 and action in ('share.created','share.revoked')")
            .bind(share_id.to_string()).fetch_one(&db).await.unwrap();
        assert_eq!(audits, 2);
    }
}
