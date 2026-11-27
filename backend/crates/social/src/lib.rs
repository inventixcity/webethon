use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    routing::{get, put},
};
use kernel::extract::{Json as Body, Path as SafePath, Query};
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    viewer::Viewer,
};
use records::{
    registry::{EntityRegistry, ReadAccess},
    service::{self, Record},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction};
use std::sync::Arc;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

mod events;
mod inbox;
pub mod moderation;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(inbox::router())
        .merge(events::router())
        .route(
            "/entities/{entity}/{id}/comments",
            get(comments).post(add_comment),
        )
        .route(
            "/comments/{id}",
            axum::routing::patch(edit_comment).delete(delete_comment),
        )
        .route("/entities/{entity}/{id}/reactions", get(reactions))
        .route(
            "/entities/{entity}/{id}/reactions/{kind}",
            put(add_reaction).delete(delete_reaction),
        )
        .route(
            "/entities/{entity}/{id}/bookmark",
            get(bookmark).put(add_bookmark).delete(delete_bookmark),
        )
        .route("/bookmarks", get(bookmarks))
        .route(
            "/users/{id}/follow",
            get(follow).put(add_follow).delete(delete_follow),
        )
}
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{"path":path,"message":message}]))
}
async fn access(
    s: &AppState,
    r: &EntityRegistry,
    v: Option<&Viewer>,
    entity: &str,
    id: Uuid,
    feature: &str,
) -> AppResult<Record> {
    let d = r.definition(entity)?;
    let record = service::get(&s.db, entity, id).await?;
    if !record.can_read(&s.db, d, v).await? {
        return Err(AppError::not_found());
    }
    let enabled = d.social.as_ref().is_some_and(|c| match feature {
        "comments" => c.comments,
        "bookmarks" => c.bookmarks,
        "reactions" => !c.reactions.is_empty(),
        _ => false,
    });
    if !enabled {
        return Err(AppError::not_found());
    }
    Ok(record)
}
async fn access_tx(
    tx: &mut Transaction<'_, Postgres>,
    r: &EntityRegistry,
    v: Option<&Viewer>,
    entity: &str,
    id: Uuid,
    feature: &str,
) -> AppResult<Record> {
    let d = r.definition(entity)?;
    let record = sqlx::query_as::<_, Record>("select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.entity=$1 and r.id=$2 and r.deleted_at is null and u.deleted_at is null for share of r,u")
        .bind(entity).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(AppError::not_found)?;
    let enabled = d.social.as_ref().is_some_and(|c| match feature {
        "comments" => c.comments,
        "bookmarks" => c.bookmarks,
        "reactions" => !c.reactions.is_empty(),
        _ => false,
    });
    if !enabled {
        return Err(AppError::not_found());
    }
    if !record.hidden_visible(v) {
        return Err(AppError::not_found());
    }
    if let Some(team_id) = record.team_id {
        let viewer = v.ok_or_else(AppError::not_found)?;
        teams::require_role_tx(tx, team_id, viewer, teams::TeamRole::Viewer).await?;
    } else if !record.readable(d, v) {
        return Err(AppError::not_found());
    }
    Ok(record)
}
async fn write_limit(s: &AppState, v: &Viewer, m: &RequestMeta) -> AppResult<()> {
    for key in [
        format!("social:user:{}", v.id),
        format!("social:ip:{}", m.ip),
    ] {
        security::enforce_rate_limit(&s.db, &key, limits::API_WRITE_PER_SUBJECT).await?;
    }
    Ok(())
}
async fn audit(s: &AppState, v: &Viewer, m: &RequestMeta, action: &str, id: Uuid) {
    security::audit(
        &s.db,
        m,
        AuditEntry {
            action,
            actor_id: Some(v.id),
            target_type: Some("social"),
            target_id: Some(id.to_string()),
            meta: json!({}),
        },
    )
    .await;
}
#[allow(clippy::too_many_arguments)]
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    recipient: Option<Uuid>,
    kind: &str,
    entity: Option<&str>,
    record: Option<Uuid>,
    comment: Option<Uuid>,
    reaction_kind: Option<&str>,
    public: bool,
) -> AppResult<()> {
    if public {
        sqlx::query("insert into social_activity(actor_id,kind,target_user_id,entity,record_id,comment_id,reaction_kind) values($1,$2,$3,$4,$5,$6,$7)").bind(actor).bind(kind).bind(if record.is_none(){recipient}else{None}).bind(entity).bind(record).bind(comment).bind(reaction_kind).execute(&mut **tx).await?;
    }
    if let Some(to) = recipient.filter(|to| *to != actor) {
        sqlx::query("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,comment_id,reaction_kind) values($1,$2,$3,$4,$5,$6,$7)").bind(to).bind(kind).bind(actor).bind(entity).bind(record).bind(comment).bind(reaction_kind).execute(&mut **tx).await?;
    }
    Ok(())
}
fn public(r: &Record, registry: &EntityRegistry) -> bool {
    r.team_id.is_none()
        && r.admin_hidden_at.is_none()
        && registry.definition(&r.entity).is_ok_and(|d| {
            d.read == ReadAccess::Public || (d.allow_public && r.visibility == "public")
        })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommentInput {
    body: String,
    parent_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditInput {
    body: String,
}
fn validate_body(body: &str) -> AppResult<()> {
    if body.trim().is_empty() || body.chars().count() > 2000 {
        Err(invalid("body", "Use 1 to 2000 characters."))
    } else {
        Ok(())
    }
}
#[derive(FromRow)]
struct Comment {
    id: Uuid,
    entity: String,
    record_id: Uuid,
    author_id: Uuid,
    parent_id: Option<Uuid>,
    body: String,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    deleted_at: Option<OffsetDateTime>,
    admin_hidden_at: Option<OffsetDateTime>,
}
impl Comment {
    fn json(&self) -> AppResult<Value> {
        let date = |d: OffsetDateTime| d.format(&Rfc3339).map_err(AppError::internal);
        Ok(
            json!({"id":self.id,"entity":self.entity,"recordId":self.record_id,"authorId":self.author_id,"parentId":self.parent_id,"body":if self.deleted_at.is_some() || self.admin_hidden_at.is_some(){None}else{Some(&self.body)},"createdAt":date(self.created_at)?,"updatedAt":date(self.updated_at)?,"deletedAt":self.deleted_at.map(date).transpose()?}),
        )
    }
}
async fn comments(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Option<Viewer>,
    SafePath((entity, id)): SafePath<(String, Uuid)>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    access_tx(&mut tx, &r, v.as_ref(), &entity, id, "comments").await?;
    let rows=sqlx::query_as::<_,Comment>("select * from social_comments where entity=$1 and record_id=$2 order by created_at,id limit 500").bind(entity).bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"data":rows.iter().map(Comment::json).collect::<AppResult<Vec<_>>>()?}),
    ))
}
async fn add_comment(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath((entity, id)): SafePath<(String, Uuid)>,
    Body(input): Body<CommentInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    validate_body(&input.body)?;
    write_limit(&s, &v, &m).await?;
    let mut tx = s.db.begin().await?;
    let record = access_tx(&mut tx, &r, Some(&v), &entity, id, "comments").await?;
    let parent_author = if let Some(parent) = input.parent_id {
        Some(sqlx::query_scalar::<_, Uuid>("select author_id from social_comments where id=$1 and entity=$2 and record_id=$3 and parent_id is null and deleted_at is null and admin_hidden_at is null for share")
            .bind(parent).bind(&entity).bind(id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| invalid("parentId", "Choose a valid top-level comment."))?)
    } else {
        None
    };
    let row=sqlx::query_as::<_,Comment>("insert into social_comments(entity,record_id,author_id,parent_id,body) values($1,$2,$3,$4,$5) returning *").bind(&entity).bind(id).bind(v.id).bind(input.parent_id).bind(input.body).fetch_one(&mut *tx).await?;
    event(
        &mut tx,
        v.id,
        Some(record.owner_id),
        if input.parent_id.is_some() {
            "reply"
        } else {
            "comment"
        },
        Some(&entity),
        Some(id),
        Some(row.id),
        None,
        public(&record, &r),
    )
    .await?;
    if let Some(parent_author) =
        parent_author.filter(|author| *author != record.owner_id && *author != v.id)
    {
        sqlx::query("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,comment_id) values($1,'reply',$2,$3,$4,$5)")
            .bind(parent_author).bind(v.id).bind(&entity).bind(id).bind(row.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    audit(&s, &v, &m, "social.comment.create", row.id).await;
    Ok((StatusCode::CREATED, Json(json!({"data":row.json()?}))))
}
async fn own_comment(s: &AppState, r: &EntityRegistry, v: &Viewer, id: Uuid) -> AppResult<Comment> {
    let c = sqlx::query_as::<_, Comment>(
        "select * from social_comments where id=$1 and author_id=$2 and deleted_at is null",
    )
    .bind(id)
    .bind(v.id)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    access(s, r, Some(v), &c.entity, c.record_id, "comments").await?;
    Ok(c)
}
async fn edit_comment(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath(id): SafePath<Uuid>,
    Body(input): Body<EditInput>,
) -> AppResult<Json<Value>> {
    validate_body(&input.body)?;
    write_limit(&s, &v, &m).await?;
    let original = own_comment(&s, &r, &v, id).await?;
    let mut tx = s.db.begin().await?;
    access_tx(
        &mut tx,
        &r,
        Some(&v),
        &original.entity,
        original.record_id,
        "comments",
    )
    .await?;
    let c=sqlx::query_as::<_,Comment>("update social_comments set body=$1,updated_at=now() where id=$2 and author_id=$3 and deleted_at is null and admin_hidden_at is null returning *").bind(input.body).bind(id).bind(v.id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    tx.commit().await?;
    audit(&s, &v, &m, "social.comment.edit", id).await;
    Ok(Json(json!({"data":c.json()?})))
}
async fn delete_comment(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath(id): SafePath<Uuid>,
) -> AppResult<StatusCode> {
    write_limit(&s, &v, &m).await?;
    let original = own_comment(&s, &r, &v, id).await?;
    let mut tx = s.db.begin().await?;
    access_tx(
        &mut tx,
        &r,
        Some(&v),
        &original.entity,
        original.record_id,
        "comments",
    )
    .await?;
    let result = sqlx::query("update social_comments set deleted_at=now(),updated_at=now() where id=$1 and author_id=$2 and deleted_at is null").bind(id).bind(v.id).execute(&mut *tx).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    tx.commit().await?;
    audit(&s, &v, &m, "social.comment.delete", id).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn reactions(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Option<Viewer>,
    SafePath((entity, id)): SafePath<(String, Uuid)>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    access_tx(&mut tx, &r, v.as_ref(), &entity, id, "reactions").await?;
    let config = r
        .definition(&entity)?
        .social
        .as_ref()
        .ok_or_else(AppError::not_found)?;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "select kind,count(*) from social_reactions where record_id=$1 group by kind",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let counts: serde_json::Map<String, Value> = rows
        .into_iter()
        .filter(|(k, _)| config.reactions.contains(k))
        .map(|(k, n)| (k, json!(n)))
        .collect();
    let mine: Vec<String> = if let Some(v) = v {
        sqlx::query_scalar(
            "select kind from social_reactions where record_id=$1 and user_id=$2 order by kind",
        )
        .bind(id)
        .bind(v.id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        vec![]
    };
    tx.commit().await?;
    Ok(Json(
        json!({"data":{"counts":counts,"mine":mine.into_iter().filter(|k|config.reactions.contains(k)).collect::<Vec<_>>()}}),
    ))
}
#[allow(clippy::too_many_arguments)]
async fn reaction_change(
    s: AppState,
    r: Arc<EntityRegistry>,
    v: Viewer,
    m: RequestMeta,
    entity: String,
    id: Uuid,
    kind: String,
    add: bool,
) -> AppResult<StatusCode> {
    if !r
        .definition(&entity)?
        .social
        .as_ref()
        .is_some_and(|c| c.reactions.contains(&kind))
    {
        return Err(AppError::not_found());
    }
    write_limit(&s, &v, &m).await?;
    let mut tx = s.db.begin().await?;
    let record = access_tx(&mut tx, &r, Some(&v), &entity, id, "reactions").await?;
    let result = if add {
        sqlx::query("insert into social_reactions(entity,record_id,user_id,kind) values($1,$2,$3,$4) on conflict do nothing").bind(&entity).bind(id).bind(v.id).bind(&kind).execute(&mut *tx).await?
    } else {
        sqlx::query("delete from social_reactions where entity=$1 and record_id=$2 and user_id=$3 and kind=$4").bind(&entity).bind(id).bind(v.id).bind(&kind).execute(&mut *tx).await?
    };
    if add && result.rows_affected() > 0 {
        event(
            &mut tx,
            v.id,
            Some(record.owner_id),
            "reaction",
            Some(&entity),
            Some(id),
            None,
            Some(&kind),
            public(&record, &r),
        )
        .await?;
    }
    tx.commit().await?;
    audit(&s, &v, &m, "social.reaction", id).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn add_reaction(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath((e, id, k)): SafePath<(String, Uuid, String)>,
) -> AppResult<StatusCode> {
    reaction_change(s, r, v, m, e, id, k, true).await
}
async fn delete_reaction(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath((e, id, k)): SafePath<(String, Uuid, String)>,
) -> AppResult<StatusCode> {
    reaction_change(s, r, v, m, e, id, k, false).await
}
async fn bookmark(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    SafePath((e, id)): SafePath<(String, Uuid)>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    access_tx(&mut tx, &r, Some(&v), &e, id, "bookmarks").await?;
    let active: bool = sqlx::query_scalar(
        "select exists(select 1 from social_bookmarks where record_id=$1 and user_id=$2)",
    )
    .bind(id)
    .bind(v.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"data":{"active":active}})))
}
async fn bookmark_change(
    s: AppState,
    r: Arc<EntityRegistry>,
    v: Viewer,
    m: RequestMeta,
    e: String,
    id: Uuid,
    add: bool,
) -> AppResult<StatusCode> {
    write_limit(&s, &v, &m).await?;
    let mut tx = s.db.begin().await?;
    access_tx(&mut tx, &r, Some(&v), &e, id, "bookmarks").await?;
    if add {
        sqlx::query("insert into social_bookmarks(entity,record_id,user_id) values($1,$2,$3) on conflict do nothing").bind(&e).bind(id).bind(v.id).execute(&mut *tx).await?;
    } else {
        sqlx::query("delete from social_bookmarks where entity=$1 and record_id=$2 and user_id=$3")
            .bind(&e)
            .bind(id)
            .bind(v.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    audit(&s, &v, &m, "social.bookmark", id).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn add_bookmark(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath((e, id)): SafePath<(String, Uuid)>,
) -> AppResult<StatusCode> {
    bookmark_change(s, r, v, m, e, id, true).await
}
async fn delete_bookmark(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    m: RequestMeta,
    SafePath((e, id)): SafePath<(String, Uuid)>,
) -> AppResult<StatusCode> {
    bookmark_change(s, r, v, m, e, id, false).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    limit: Option<u32>,
    cursor: Option<Uuid>,
}
async fn bookmarks(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
    Query(p): Query<Page>,
) -> AppResult<Json<Value>> {
    let limit = p.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Use a value from 1 to 100."));
    }
    let rows:Vec<(String,Uuid)>=sqlx::query_as("select entity,record_id from social_bookmarks where user_id=$1 and ($2::uuid is null or record_id > $2) order by record_id limit 501").bind(v.id).bind(p.cursor).fetch_all(&s.db).await?;
    let ids: Vec<Uuid> = rows.iter().map(|(_, id)| *id).collect();
    let records: Vec<Record> = sqlx::query_as("select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.id=any($1) and r.deleted_at is null and u.deleted_at is null")
        .bind(&ids).fetch_all(&s.db).await?;
    let team_ids: Vec<Uuid> = records.iter().filter_map(|record| record.team_id).collect();
    let memberships: Vec<Uuid> = sqlx::query_scalar("select m.team_id from team_members m join teams t on t.id=m.team_id join users u on u.id=m.user_id where m.team_id=any($1) and m.user_id=$2 and t.deleted_at is null and u.deleted_at is null and m.role in ('viewer','member','admin','owner')")
        .bind(&team_ids).bind(v.id).fetch_all(&s.db).await?;
    let records: std::collections::HashMap<Uuid, Record> = records
        .into_iter()
        .map(|record| (record.id, record))
        .collect();
    let memberships: std::collections::HashSet<Uuid> = memberships.into_iter().collect();
    let mut items = Vec::new();
    let mut cursor = None;
    let total = rows.len();
    for (index, (e, id)) in rows.into_iter().enumerate() {
        if let (Ok(definition), Some(record)) = (r.definition(&e), records.get(&id)) {
            let enabled = definition
                .social
                .as_ref()
                .is_some_and(|social| social.bookmarks);
            let readable = record.entity == e
                && record.hidden_visible(Some(&v))
                && match record.team_id {
                    Some(team) => memberships.contains(&team),
                    None => record.readable(definition, Some(&v)),
                };
            if enabled && readable {
                items.push(record.json()?);
            }
        }
        if items.len() == limit as usize || index == 500 {
            if index + 1 < total || total == 501 {
                cursor = Some(id);
            }
            break;
        }
    }
    Ok(Json(json!({"data":items,"meta":{"nextCursor":cursor}})))
}
async fn target(s: &AppState, id: Uuid) -> AppResult<()> {
    let active: bool = sqlx::query_scalar(
        "select exists(select 1 from users where id=$1 and deleted_at is null and status='active')",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await?;
    if active {
        Ok(())
    } else {
        Err(AppError::not_found())
    }
}
async fn follow(
    State(s): State<AppState>,
    v: Viewer,
    SafePath(id): SafePath<Uuid>,
) -> AppResult<Json<Value>> {
    target(&s, id).await?;
    let active: bool = sqlx::query_scalar(
        "select exists(select 1 from social_follows where follower_id=$1 and followed_id=$2)",
    )
    .bind(v.id)
    .bind(id)
    .fetch_one(&s.db)
    .await?;
    Ok(Json(json!({"data":{"active":active}})))
}
async fn follow_change(
    s: AppState,
    v: Viewer,
    m: RequestMeta,
    id: Uuid,
    add: bool,
) -> AppResult<StatusCode> {
    target(&s, id).await?;
    if id == v.id {
        return Err(invalid("id", "You cannot follow yourself."));
    }
    write_limit(&s, &v, &m).await?;
    let mut tx = s.db.begin().await?;
    sqlx::query_scalar::<_, Uuid>(
        "select id from users where id=$1 and deleted_at is null and status='active' for share",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    let result = if add {
        sqlx::query("insert into social_follows(follower_id,followed_id) values($1,$2) on conflict do nothing").bind(v.id).bind(id).execute(&mut *tx).await?
    } else {
        sqlx::query("delete from social_follows where follower_id=$1 and followed_id=$2")
            .bind(v.id)
            .bind(id)
            .execute(&mut *tx)
            .await?
    };
    if add && result.rows_affected() > 0 {
        event(
            &mut tx,
            v.id,
            Some(id),
            "follow",
            None,
            None,
            None,
            None,
            true,
        )
        .await?;
    }
    tx.commit().await?;
    audit(&s, &v, &m, "social.follow", id).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn add_follow(
    State(s): State<AppState>,
    v: Viewer,
    m: RequestMeta,
    SafePath(id): SafePath<Uuid>,
) -> AppResult<StatusCode> {
    follow_change(s, v, m, id, true).await
}
async fn delete_follow(
    State(s): State<AppState>,
    v: Viewer,
    m: RequestMeta,
    SafePath(id): SafePath<Uuid>,
) -> AppResult<StatusCode> {
    follow_change(s, v, m, id, false).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        body::{Body as HttpBody, to_bytes},
        http::Request,
    };
    use kernel::{config::Config, email::LogSender, session};
    use tower::ServiceExt;

    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let content = if let Some(body) = body {
            req = req.header("content-type", "application/json");
            body.to_string()
        } else {
            String::new()
        };
        let response = app
            .clone()
            .oneshot(req.body(HttpBody::from(content)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn user(db: &sqlx::PgPool, config: &Config) -> (Uuid, String) {
        let id = sqlx::query_scalar("insert into users(email) values($1) returning id")
            .bind(format!("{}@example.com", Uuid::new_v4()))
            .fetch_one(db)
            .await
            .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, _) = session::create(db, config, id, &meta).await.unwrap();
        (id, token)
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn moderation_hides_comment_and_record_activity(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let registry =
            Arc::new(EntityRegistry::from_json(&json!({"notes":definition}).to_string()).unwrap());
        let app = router().layer(Extension(registry)).with_state(state);
        let (owner, owner_token) = user(&db, &config).await;
        let (actor, actor_token) = user(&db, &config).await;
        sqlx::query("insert into social_follows(follower_id,followed_id) values($1,$2)")
            .bind(owner)
            .bind(actor)
            .execute(&db)
            .await
            .unwrap();
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let path = format!("/entities/notes/{record}/comments");
        let (_, posted) = call(
            &app,
            "POST",
            &path,
            Some(&actor_token),
            Some(json!({"body":"secret"})),
        )
        .await;
        let id = posted["data"]["id"].as_str().unwrap();
        sqlx::query("update social_comments set admin_hidden_at=now() where id=$1")
            .bind(Uuid::parse_str(id).unwrap())
            .execute(&db)
            .await
            .unwrap();
        for token in [&actor_token, &owner_token] {
            let (status, list) = call(&app, "GET", &path, Some(token), None).await;
            assert_eq!(status, StatusCode::OK);
            assert!(list["data"][0]["body"].is_null());
        }
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{id}"),
                Some(&actor_token),
                Some(json!({"body":"changed"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner_token),
                Some(json!({"body":"reply","parentId":id}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/comments/{id}"),
                Some(&actor_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        sqlx::query("update records set admin_hidden_at=now() where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "GET", &path, Some(&actor_token), None).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner_token), None).await.0,
            StatusCode::OK
        );
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn moderator_hide_restore_and_read_keep_body_private(db: sqlx::PgPool) {
        async fn unread(app: &Router, token: &str) -> i64 {
            call(app, "GET", "/notifications/count", Some(token), None)
                .await
                .1["data"]["unreadCount"]
                .as_i64()
                .unwrap()
        }
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let registry =
            Arc::new(EntityRegistry::from_json(&json!({"notes":definition}).to_string()).unwrap());
        let app = router().layer(Extension(registry)).with_state(state);
        let (owner, owner_token) = user(&db, &config).await;
        let (actor, actor_token) = user(&db, &config).await;
        let (_, outsider_token) = user(&db, &config).await;
        sqlx::query("insert into social_follows(follower_id,followed_id) values($1,$2)")
            .bind(owner)
            .bind(actor)
            .execute(&db)
            .await
            .unwrap();
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let comments = format!("/entities/notes/{record}/comments");
        let (status, posted) = call(
            &app,
            "POST",
            &comments,
            Some(&actor_token),
            Some(json!({"body":"secret"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let hidden_id = posted["data"]["id"].as_str().unwrap().to_owned();
        let hidden = Uuid::parse_str(&hidden_id).unwrap();
        let (status, _) = call(
            &app,
            "POST",
            &comments,
            Some(&owner_token),
            Some(json!({"body":"public reply","parentId":hidden_id})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        // Before hiding: owner has the comment, actor has the reply, and the feed shows the comment.
        assert_eq!(unread(&app, &owner_token).await, 1);
        assert_eq!(unread(&app, &actor_token).await, 1);
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let mut tx = db.begin().await.unwrap();
        moderation::set_comment_admin_hidden(&mut tx, hidden, true)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // The hidden body is null for everyone; the reply to it stays visible.
        for token in [&owner_token, &actor_token, &outsider_token] {
            let (status, list) = call(&app, "GET", &comments, Some(token), None).await;
            assert_eq!(status, StatusCode::OK);
            assert!(list["data"][0]["body"].is_null());
            assert_eq!(list["data"][1]["body"], "public reply");
            assert!(!list.to_string().contains("secret"));
        }
        // Inbox and activity never carry the body, and the hidden comment's items disappear.
        for path in ["/notifications", "/activity"] {
            for token in [&owner_token, &actor_token] {
                let (_, body) = call(&app, "GET", path, Some(token), None).await;
                assert!(!body.to_string().contains("secret"));
            }
        }
        assert_eq!(unread(&app, &owner_token).await, 0);
        assert_eq!(unread(&app, &actor_token).await, 1);
        assert!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        // The author can't edit a hidden comment, even with an extra field to flip the flag.
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{hidden_id}"),
                Some(&actor_token),
                Some(json!({"body":"changed"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{hidden_id}"),
                Some(&actor_token),
                Some(json!({"body":"changed","adminHiddenAt":null}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        // Neither the record owner nor any other user can edit or delete someone else's comment.
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{hidden_id}"),
                Some(&owner_token),
                Some(json!({"body":"changed"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/comments/{hidden_id}"),
                Some(&owner_token),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (body, still_hidden): (String, bool) = sqlx::query_as(
            "select body, admin_hidden_at is not null from social_comments where id=$1",
        )
        .bind(hidden)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(body, "secret");
        assert!(still_hidden);

        // Moderators can read the body. Missing IDs and bad page sizes are rejected.
        let filter = moderation::CommentFilter {
            record_id: Some(record),
            hidden: Some(true),
            ..Default::default()
        };
        let page = moderation::list_comments(&db, &filter, 10, None)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].body(), Some("secret"));
        assert!(page.next_cursor.is_none());
        assert!(
            moderation::list_comments(&db, &filter, 0, None)
                .await
                .is_err()
        );
        assert!(
            moderation::list_comments(
                &db,
                &moderation::CommentFilter::default(),
                10,
                Some(Uuid::new_v4())
            )
            .await
            .is_err()
        );
        let one = moderation::get_comment(&db, hidden).await.unwrap().unwrap();
        assert_eq!(one.json().unwrap()["body"], "secret");

        // Restoring brings back the body, the inbox count and the activity item.
        let mut tx = db.begin().await.unwrap();
        moderation::set_comment_admin_hidden(&mut tx, hidden, false)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let (_, list) = call(&app, "GET", &comments, Some(&actor_token), None).await;
        assert_eq!(list["data"][0]["body"], "secret");
        assert_eq!(unread(&app, &owner_token).await, 1);
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // Hide again. A missing ID is not found and does not change anything.
        let mut tx = db.begin().await.unwrap();
        assert!(
            moderation::set_comment_admin_hidden(&mut tx, Uuid::new_v4(), true)
                .await
                .is_err()
        );
        moderation::set_comment_admin_hidden(&mut tx, hidden, true)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // The author may still delete a hidden comment. The moderator read keeps the body,
        // and the ordinary list shows only the placeholder.
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/comments/{hidden_id}"),
                Some(&actor_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        let (_, list) = call(&app, "GET", &comments, Some(&actor_token), None).await;
        assert!(list["data"][0]["body"].is_null());
        assert!(list["data"][0]["deletedAt"].is_string());
        let admin_view = moderation::get_comment(&db, hidden).await.unwrap().unwrap();
        assert!(admin_view.admin_hidden_at.is_some());
        assert_eq!(admin_view.body(), Some("secret"));

        // Reactions and bookmarks on the record are unaffected by the comment flag.
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/entities/notes/{record}/reactions/like"),
                Some(&outsider_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/entities/notes/{record}/bookmark"),
                Some(&outsider_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        let (_, reactions) = call(
            &app,
            "GET",
            &format!("/entities/notes/{record}/reactions"),
            Some(&outsider_token),
            None,
        )
        .await;
        assert_eq!(reactions["data"]["counts"]["like"], 1);
        let (_, bookmark) = call(
            &app,
            "GET",
            &format!("/entities/notes/{record}/bookmark"),
            Some(&outsider_token),
            None,
        )
        .await;
        assert_eq!(bookmark["data"]["active"], true);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn team_membership_controls_social_and_inbox(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let registry =
            Arc::new(EntityRegistry::from_json(&json!({"notes":definition}).to_string()).unwrap());
        let app = router().layer(Extension(registry)).with_state(state);
        let (owner, owner_token) = user(&db, &config).await;
        let (member, member_token) = user(&db, &config).await;
        let (outsider, outsider_token) = user(&db, &config).await;
        sqlx::query("update users set role='admin' where id=$1")
            .bind(outsider)
            .execute(&db)
            .await
            .unwrap();
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Team','team-test',$1) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query(
            "insert into team_members(team_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",
        )
        .bind(team)
        .bind(owner)
        .bind(member)
        .execute(&db)
        .await
        .unwrap();
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data,visibility) values('notes',$1,$2,'{}','private') returning id").bind(owner).bind(team).fetch_one(&db).await.unwrap();
        let comments = format!("/entities/notes/{record}/comments");
        assert_eq!(
            call(&app, "GET", &comments, Some(&outsider_token), None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let (status, comment) = call(
            &app,
            "POST",
            &comments,
            Some(&member_token),
            Some(json!({"body":"hello"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let comment_id = comment["data"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{comment_id}"),
                Some(&owner_token),
                Some(json!({"body":"no"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/entities/notes/{record}/reactions/like"),
                Some(&member_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/entities/notes/{record}/bookmark"),
                Some(&member_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(&app, "GET", "/bookmarks", Some(&member_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            2
        );
        assert!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let (_, page) = call(
            &app,
            "GET",
            "/notifications?limit=1",
            Some(&owner_token),
            None,
        )
        .await;
        let notification_id = page["data"][0]["id"].as_str().unwrap().to_owned();
        let cursor = page["meta"]["nextCursor"].as_str().unwrap().to_owned();
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/notifications?limit=1&cursor={cursor}"),
                Some(&owner_token),
                None
            )
            .await
            .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        sqlx::query("update records set admin_hidden_at=now() where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        assert!(
            call(&app, "GET", "/notifications", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            call(&app, "GET", "/activity", Some(&member_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        for role in ["viewer", "member", "admin"] {
            sqlx::query("update team_members set role=$3 where team_id=$1 and user_id=$2")
                .bind(team)
                .bind(member)
                .bind(role)
                .execute(&db)
                .await
                .unwrap();
            for (method, path, body) in [
                ("GET", comments.clone(), None),
                ("POST", comments.clone(), Some(json!({"body":"hidden"}))),
                ("GET", format!("/entities/notes/{record}/reactions"), None),
                (
                    "PUT",
                    format!("/entities/notes/{record}/reactions/like"),
                    None,
                ),
                ("GET", format!("/entities/notes/{record}/bookmark"), None),
                ("PUT", format!("/entities/notes/{record}/bookmark"), None),
            ] {
                assert_eq!(
                    call(&app, method, &path, Some(&member_token), body).await.0,
                    StatusCode::NOT_FOUND
                );
            }
            assert!(
                call(&app, "GET", "/bookmarks", Some(&member_token), None)
                    .await
                    .1["data"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(
            call(&app, "GET", &comments, Some(&owner_token), None)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", &comments, Some(&outsider_token), None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        sqlx::query("update records set admin_hidden_at=null where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(member)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/notifications/read",
                Some(&owner_token),
                Some(json!({"ids":[notification_id]}))
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        let read_at: Option<OffsetDateTime> =
            sqlx::query_scalar("select read_at from social_notifications where id=$1")
                .bind(Uuid::parse_str(&notification_id).unwrap())
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(read_at.is_none());
        assert!(
            call(
                &app,
                "GET",
                &format!("/notifications?cursor={cursor}"),
                Some(&owner_token),
                None
            )
            .await
            .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            call(&app, "GET", &comments, Some(&member_token), None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/comments/{comment_id}"),
                Some(&member_token),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert!(
            call(&app, "GET", "/bookmarks", Some(&member_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        assert!(
            call(&app, "GET", "/notifications", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn router_security_and_idempotency(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let mut disabled = definition.clone();
        disabled["social"] = json!({});
        let registry = Arc::new(
            EntityRegistry::from_json(&json!({"notes":definition,"disabled":disabled}).to_string())
                .unwrap(),
        );
        let app = router().layer(Extension(registry)).with_state(state);
        let (owner, owner_token) = user(&db, &config).await;
        let (author, author_token) = user(&db, &config).await;
        let (_, other_token) = user(&db, &config).await;
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let path = format!("/entities/notes/{id}/comments");
        let (_, parent) = call(
            &app,
            "POST",
            &path,
            Some(&author_token),
            Some(json!({"body":"parent"})),
        )
        .await;
        let parent = parent["data"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/comments/{parent}"),
                Some(&other_token),
                Some(json!({"body":"bad"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (status, reply) = call(
            &app,
            "POST",
            &path,
            Some(&other_token),
            Some(json!({"body":"reply","parentId":parent})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let reply = reply["data"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner_token),
                Some(json!({"body":"nested","parentId":reply}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let another: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("/entities/notes/{another}/comments"),
                Some(&owner_token),
                Some(json!({"body":"wrong","parentId":parent}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/comments/{parent}"),
                Some(&other_token),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let disabled_id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('disabled',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/entities/disabled/{disabled_id}/comments"),
                Some(&owner_token),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let recipients: Vec<Uuid> =
            sqlx::query_scalar("select recipient_id from social_notifications where comment_id=$1")
                .bind(Uuid::parse_str(reply).unwrap())
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(recipients.len(), 2);
        assert!(recipients.contains(&owner));
        assert!(recipients.contains(&author));
        for path in [
            format!("/entities/notes/{id}/reactions/like"),
            format!("/entities/notes/{id}/bookmark"),
            format!("/users/{owner}/follow"),
        ] {
            assert_eq!(
                call(&app, "PUT", &path, Some(&author_token), None).await.0,
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                call(&app, "PUT", &path, Some(&author_token), None).await.0,
                StatusCode::NO_CONTENT
            );
        }
        let count: i64 = sqlx::query_scalar(
            "select count(*) from social_notifications where kind in ('reaction','follow')",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count, 2);
        let audit_count: i64 =
            sqlx::query_scalar("select count(*) from audit_log where action like 'social.%'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(audit_count >= 8);
        for _ in 0..120 {
            security::rate_limit_hit(
                &db,
                &format!("social:user:{author}"),
                limits::API_WRITE_PER_SUBJECT,
            )
            .await
            .unwrap();
        }
        for (method, url, body) in [
            ("POST", path.clone(), Some(json!({"body":"limited"}))),
            (
                "PATCH",
                format!("/comments/{parent}"),
                Some(json!({"body":"limited"})),
            ),
            ("DELETE", format!("/comments/{parent}"), None),
            ("PUT", format!("/entities/notes/{id}/reactions/like"), None),
            (
                "DELETE",
                format!("/entities/notes/{id}/reactions/like"),
                None,
            ),
            ("PUT", format!("/entities/notes/{id}/bookmark"), None),
            ("DELETE", format!("/entities/notes/{id}/bookmark"), None),
            ("PUT", format!("/users/{owner}/follow"), None),
            ("DELETE", format!("/users/{owner}/follow"), None),
            (
                "POST",
                "/notifications/read".to_string(),
                Some(json!({"all":true})),
            ),
        ] {
            assert_eq!(
                call(&app, method, &url, Some(&author_token), body).await.0,
                StatusCode::TOO_MANY_REQUESTS
            );
        }
        sqlx::query("update records set visibility='private' where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "GET", &path, Some(&author_token), None).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner_token), None).await.0,
            StatusCode::OK
        );
        sqlx::query("update users set deleted_at=now() where id=$1")
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "GET", &path, Some(&author_token), None).await.0,
            StatusCode::NOT_FOUND
        );
    }
    #[test]
    fn comment_bounds() {
        assert!(validate_body("hello").is_ok());
        assert!(validate_body(" ").is_err());
        assert!(validate_body(&"x".repeat(2001)).is_err());
        assert!(validate_body(&"x".repeat(2000)).is_ok());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn events_are_transactional_and_self_notifications_suppressed(db: sqlx::PgPool) {
        let a: Uuid = sqlx::query_scalar(
            "insert into users(email) values('social-a@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let b: Uuid = sqlx::query_scalar(
            "insert into users(email) values('social-b@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        event(&mut tx, a, Some(b), "follow", None, None, None, None, true)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from social_notifications")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let mut tx = db.begin().await.unwrap();
        event(&mut tx, a, Some(a), "follow", None, None, None, None, true)
            .await
            .unwrap();
        event(&mut tx, a, Some(b), "follow", None, None, None, None, true)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from social_notifications")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let count: i64 = sqlx::query_scalar("select count(*) from social_activity")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn notify_contains_only_identifiers(db: sqlx::PgPool) {
        let a: Uuid =
            sqlx::query_scalar("insert into users(email) values('actor@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let b: Uuid = sqlx::query_scalar(
            "insert into users(email) values('recipient@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let mut listener = sqlx::postgres::PgListener::connect_with(&db).await.unwrap();
        listener.listen("social_notifications").await.unwrap();
        let mut tx = db.begin().await.unwrap();
        event(&mut tx, a, Some(b), "follow", None, None, None, None, true)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let message = tokio::time::timeout(std::time::Duration::from_secs(5), listener.recv())
            .await
            .unwrap()
            .unwrap();
        let payload: Value = serde_json::from_str(message.payload()).unwrap();
        assert_eq!(payload.as_object().unwrap().len(), 2);
        assert_eq!(payload["recipientId"], b.to_string());
        assert!(
            payload["notificationId"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .is_ok()
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn inbox_visibility_pagination_and_reads(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let registry = Arc::new(
            EntityRegistry::from_json(&json!({"notes":definition.clone()}).to_string()).unwrap(),
        );
        let app = router()
            .layer(Extension(registry))
            .with_state(state.clone());
        let (owner, owner_token) = user(&db, &config).await;
        let (actor, actor_token) = user(&db, &config).await;
        let (_, other_token) = user(&db, &config).await;
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let path = format!("/entities/notes/{record}/comments");
        for body in ["one", "two"] {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &path,
                    Some(&actor_token),
                    Some(json!({"body":body}))
                )
                .await
                .0,
                StatusCode::CREATED
            );
        }
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/users/{actor}/follow"),
                Some(&owner_token),
                None
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        let (status, first) = call(
            &app,
            "GET",
            "/notifications?limit=1",
            Some(&owner_token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["meta"]["unreadCount"], 2);
        assert!(first["data"][0]["actor"].get("email").is_none());
        let cursor = first["meta"]["nextCursor"].as_str().unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/notifications?limit=1&cursor={cursor}"),
                Some(&owner_token),
                None
            )
            .await
            .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_ne!(
            call(
                &app,
                "GET",
                &format!("/notifications?cursor={cursor}"),
                Some(&other_token),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/notifications/read",
                Some(&owner_token),
                Some(json!({"ids":[cursor,Uuid::new_v4()]}))
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/notifications/read",
                Some(&owner_token),
                Some(json!({"ids":[cursor]}))
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            1
        );
        sqlx::query("update records set visibility='private' where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        sqlx::query("update records set visibility='public' where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        let mut disabled = definition;
        disabled["social"] = json!({});
        let app_disabled = router()
            .layer(Extension(Arc::new(
                EntityRegistry::from_json(&json!({"notes":disabled}).to_string()).unwrap(),
            )))
            .with_state(state);
        assert_eq!(
            call(
                &app_disabled,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        sqlx::query("update records set deleted_at=now() where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
    }
    fn test_app(
        db: &sqlx::PgPool,
        config: &Arc<Config>,
        kinds: &[&str],
    ) -> (Router, AppState, Arc<EntityRegistry>) {
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":kinds,"bookmarks":true}});
        let registry =
            Arc::new(EntityRegistry::from_json(&json!({"notes":definition}).to_string()).unwrap());
        (
            router()
                .layer(Extension(registry.clone()))
                .with_state(state.clone()),
            state,
            registry,
        )
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn reaction_kind_visibility_and_idempotence(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let (app, state, _) = test_app(&db, &config, &["like", "love"]);
        let (owner, owner_token) = user(&db, &config).await;
        let (actor, actor_token) = user(&db, &config).await;
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        call(
            &app,
            "PUT",
            &format!("/users/{actor}/follow"),
            Some(&owner_token),
            None,
        )
        .await;
        for kind in ["like", "like", "love"] {
            assert_eq!(
                call(
                    &app,
                    "PUT",
                    &format!("/entities/notes/{record}/reactions/{kind}"),
                    Some(&actor_token),
                    None
                )
                .await
                .0,
                StatusCode::NO_CONTENT
            );
        }
        let kinds: Vec<String> = sqlx::query_scalar("select reaction_kind from social_notifications where kind='reaction' order by reaction_kind").fetch_all(&db).await.unwrap();
        assert_eq!(kinds, vec!["like", "love"]);
        let n: i64 =
            sqlx::query_scalar("select count(*) from social_activity where kind='reaction'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(n, 2);
        let legacy: Uuid = sqlx::query_scalar("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id) values($1,'reaction',$2,'notes',$3) returning id").bind(owner).bind(actor).bind(record).fetch_one(&db).await.unwrap();
        sqlx::query("insert into social_activity(actor_id,kind,entity,record_id) values($1,'reaction','notes',$2)").bind(actor).bind(record).execute(&db).await.unwrap();
        let (limited, _, registry) = test_app(&db, &config, &["love"]);
        let notice: Uuid =
            sqlx::query_scalar("select id from social_notifications where reaction_kind='like'")
                .fetch_one(&db)
                .await
                .unwrap();
        let viewer = Viewer {
            id: owner,
            session_id: Uuid::new_v4(),
            email: String::new(),
            display_name: String::new(),
            role: kernel::viewer::Role::User,
            via_cookie: false,
        };
        assert!(
            inbox::notification_by_id(&state, &registry, &viewer, notice)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            inbox::notification_by_id(&state, &registry, &viewer, legacy)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            call(
                &limited,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            1
        );
        assert_eq!(
            call(&limited, "GET", "/notifications", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            call(&limited, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        call(
            &limited,
            "POST",
            "/notifications/read",
            Some(&owner_token),
            Some(json!({"all":true})),
        )
        .await;
        let unread: i64 = sqlx::query_scalar(
            "select count(*) from social_notifications where read_at is null and recipient_id=$1",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unread, 2);
    }

    async fn wait_for_blocker(db: &sqlx::PgPool, pid: i32) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let blocked: bool = sqlx::query_scalar("select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)))").bind(pid).fetch_one(db).await.unwrap();
                if blocked { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn privacy_and_comment_lock_order(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let (app, _, registry) = test_app(&db, &config, &["like"]);
        let (owner, owner_token) = user(&db, &config).await;
        let (actor, actor_token) = user(&db, &config).await;
        call(
            &app,
            "PUT",
            &format!("/users/{actor}/follow"),
            Some(&owner_token),
            None,
        )
        .await;
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let mut privacy = db.begin().await.unwrap();
        let pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
            .fetch_one(&mut *privacy)
            .await
            .unwrap();
        sqlx::query("update records set visibility='private' where id=$1")
            .bind(record)
            .execute(&mut *privacy)
            .await
            .unwrap();
        let cloned = app.clone();
        let token = actor_token.clone();
        let request = tokio::spawn(async move {
            call(
                &cloned,
                "POST",
                &format!("/entities/notes/{record}/comments"),
                Some(&token),
                Some(json!({"body":"blocked"})),
            )
            .await
            .0
        });
        wait_for_blocker(&db, pid).await;
        privacy.commit().await.unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(10), request)
                .await
                .unwrap()
                .unwrap(),
            StatusCode::NOT_FOUND
        );
        for table in ["social_comments", "social_notifications", "social_activity"] {
            let count: i64 =
                sqlx::query_scalar(&format!("select count(*) from {table} where record_id=$1"))
                    .bind(record)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        }
        sqlx::query("update records set visibility='public' where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        let viewer = Viewer {
            id: actor,
            session_id: Uuid::new_v4(),
            email: String::new(),
            display_name: String::new(),
            role: kernel::viewer::Role::User,
            via_cookie: false,
        };
        let mut comment = db.begin().await.unwrap();
        let pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
            .fetch_one(&mut *comment)
            .await
            .unwrap();
        access_tx(
            &mut comment,
            &registry,
            Some(&viewer),
            "notes",
            record,
            "comments",
        )
        .await
        .unwrap();
        let comment_id: Uuid = sqlx::query_scalar("insert into social_comments(entity,record_id,author_id,body) values('notes',$1,$2,'first') returning id").bind(record).bind(actor).fetch_one(&mut *comment).await.unwrap();
        event(
            &mut comment,
            actor,
            Some(owner),
            "comment",
            Some("notes"),
            Some(record),
            Some(comment_id),
            None,
            true,
        )
        .await
        .unwrap();
        let pool = db.clone();
        let update = tokio::spawn(async move {
            sqlx::query("update records set visibility='private' where id=$1")
                .bind(record)
                .execute(&pool)
                .await
                .unwrap();
        });
        wait_for_blocker(&db, pid).await;
        comment.commit().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), update)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                "/notifications/count",
                Some(&owner_token),
                None
            )
            .await
            .1["data"]["unreadCount"],
            0
        );
        assert_eq!(
            call(&app, "GET", "/notifications", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            call(&app, "GET", "/activity", Some(&owner_token), None)
                .await
                .1["data"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn write_audit_and_independent_ip_budget(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let (app, _, _) = test_app(&db, &config, &["like"]);
        let (owner, _) = user(&db, &config).await;
        let (_, token) = user(&db, &config).await;
        let record: Uuid=sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let comments = format!("/entities/notes/{record}/comments");
        let (status, body) = call(
            &app,
            "POST",
            &comments,
            Some(&token),
            Some(json!({"body":"hello"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let comment = body["data"]["id"].as_str().unwrap();
        let writes = [
            (
                "PATCH",
                format!("/comments/{comment}"),
                Some(json!({"body":"edited"})),
            ),
            ("DELETE", format!("/comments/{comment}"), None),
            (
                "PUT",
                format!("/entities/notes/{record}/reactions/like"),
                None,
            ),
            (
                "DELETE",
                format!("/entities/notes/{record}/reactions/like"),
                None,
            ),
            ("PUT", format!("/entities/notes/{record}/bookmark"), None),
            ("DELETE", format!("/entities/notes/{record}/bookmark"), None),
            ("PUT", format!("/users/{owner}/follow"), None),
            ("DELETE", format!("/users/{owner}/follow"), None),
            (
                "POST",
                "/notifications/read".to_string(),
                Some(json!({"all":true})),
            ),
        ];
        for (method, path, body) in &writes {
            assert_eq!(
                call(&app, method, path, Some(&token), body.clone()).await.0,
                if *method == "PATCH" {
                    StatusCode::OK
                } else {
                    StatusCode::NO_CONTENT
                }
            );
        }
        for (action, expected) in [
            ("social.comment.create", 1_i64),
            ("social.comment.edit", 1),
            ("social.comment.delete", 1),
            ("social.reaction", 2),
            ("social.bookmark", 2),
            ("social.follow", 2),
            ("social.notifications.read", 1),
        ] {
            let count: i64 = sqlx::query_scalar("select count(*) from audit_log where action=$1")
                .bind(action)
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(count, expected, "{action}");
        }
        for _ in 0..120 {
            security::rate_limit_hit(&db, "social:ip:unknown", limits::API_WRITE_PER_SUBJECT)
                .await
                .unwrap();
        }
        let (_, fresh) = user(&db, &config).await;
        assert_eq!(
            call(
                &app,
                "POST",
                &comments,
                Some(&fresh),
                Some(json!({"body":"blocked"}))
            )
            .await
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        for (method, path, body) in &writes {
            assert_eq!(
                call(&app, method, path, Some(&fresh), body.clone()).await.0,
                StatusCode::TOO_MANY_REQUESTS
            );
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod extractor_rejection_tests {
    use super::*;
    use axum::extract::FromRequest;
    #[tokio::test]
    async fn malformed_path_and_query_use_shared_errors() {
        use axum::{
            body::{Body as RequestBody, to_bytes},
            http::Request,
            routing::get,
        };
        use tower::ServiceExt;
        let app = Router::new()
            .route("/item/{id}", get(|SafePath(_id): SafePath<Uuid>| async {}))
            .route("/page", get(|Query(_page): Query<Page>| async {}));
        for (uri, status, code, path) in [
            ("/item/not-a-uuid", StatusCode::NOT_FOUND, "NOT_FOUND", ""),
            (
                "/page?limit=bad",
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
                "limit",
            ),
            (
                "/page?extra=x",
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
                "extra",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(Request::get(uri).body(RequestBody::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["error"]["code"], code);
            if !path.is_empty() {
                assert_eq!(value["error"]["details"][0]["path"], path);
            }
        }
        assert!(validate_body(&"x".repeat(2001)).is_err());
    }
    #[tokio::test]
    async fn dto_rejections_use_shared_errors() {
        for (body, code, path) in [
            ("{}", kernel::ErrorCode::ValidationFailed, "body"),
            ("{\"body\":5}", kernel::ErrorCode::ValidationFailed, "body"),
            (
                "{\"body\":\"x\",\"extra\":1}",
                kernel::ErrorCode::ValidationFailed,
                "extra",
            ),
        ] {
            let request = axum::http::Request::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            let error =
                match <Body<CommentInput> as FromRequest<()>>::from_request(request, &()).await {
                    Ok(_) => panic!("invalid input accepted"),
                    Err(error) => error,
                };
            assert_eq!(error.code, code);
            if !path.is_empty() {
                assert_eq!(error.details.unwrap()[0]["path"], path);
            }
        }
    }
}
