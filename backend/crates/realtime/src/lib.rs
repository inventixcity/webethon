//! Live record change notifications. Record data is never sent over this channel.
use std::{
    collections::HashMap,
    convert::Infallible,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use axum::{
    Extension, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::get,
};
use kernel::extract::{Path, Query};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, request::RequestMeta, session, viewer::Viewer,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgListener};
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    id: Uuid,
    entity: String,
    owner_id: Uuid,
    #[serde(deserialize_with = "Option::<Uuid>::deserialize")]
    team_id: Option<Uuid>,
    visibility: String,
    version: i32,
    op: String,
}
#[derive(Serialize)]
struct PublicChange<'a> {
    id: Uuid,
    entity: &'a str,
    op: &'a str,
    version: i32,
}
#[derive(Clone)]
enum Message {
    Change(Arc<Change>),
    Resync,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityRule {
    read: String,
    allow_public: bool,
}
#[derive(Default)]
struct Counts {
    total: usize,
    users: HashMap<Uuid, usize>,
    anonymous: HashMap<String, usize>,
}
/// How often an open stream re-checks its session. Each check reads the database, so a longer
/// interval means fewer reads per open stream; a revoked session still ends within a minute.
const SESSION_RECHECK: Duration = Duration::from_secs(60);
/// The shared public-visibility result for one change, used by every subscriber that receives it.
struct VisibilityEntry {
    // Keeps the change alive, so its address (the map key) cannot be reused while the entry exists.
    change: Arc<Change>,
    result: tokio::sync::watch::Receiver<Option<bool>>,
}
struct Shared {
    tx: broadcast::Sender<Message>,
    counts: Mutex<Counts>,
    rules: OnceLock<Result<HashMap<String, EntityRule>, String>>,
    visibility: Mutex<HashMap<usize, VisibilityEntry>>,
    #[cfg(test)]
    visibility_queries: std::sync::atomic::AtomicUsize,
}
/// Shared notification hub, cloned cheaply for each request.
#[derive(Clone)]
pub struct Hub(Arc<Shared>);

/// Connects before returning, then maintains a single listener until shutdown.
pub async fn spawn_listener(
    db: PgPool,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<Hub> {
    let mut listener = PgListener::connect_with(&db).await?;
    listener.eager_reconnect(false);
    listener.listen("records_changed").await?;
    let (tx, _) = broadcast::channel(1024);
    let hub = Hub(Arc::new(Shared {
        tx,
        counts: Mutex::new(Counts::default()),
        rules: OnceLock::new(),
        visibility: Mutex::new(HashMap::new()),
        #[cfg(test)]
        visibility_queries: std::sync::atomic::AtomicUsize::new(0),
    }));
    let sender = hub.0.tx.clone();
    tokio::spawn(async move {
        tokio::pin!(shutdown);
        let mut backoff = Duration::from_secs(1);
        loop {
            tokio::select! {
                () = &mut shutdown => break,
                result = listener.try_recv() => match result {
                    Ok(Some(note)) => {
                        backoff = Duration::from_secs(1);
                        match serde_json::from_str::<Change>(note.payload()) {
                            Ok(change) => { let _ = sender.send(Message::Change(Arc::new(change))); }
                            Err(_) => { let _ = sender.send(Message::Resync); }
                        }
                    }
                    result => {
                        if let Err(error) = result { tracing::warn!(%error, "realtime listener disconnected"); }
                        let _ = sender.send(Message::Resync);
                        // PgListener reconnects and re-subscribes on the next recv.
                        tokio::select! { () = &mut shutdown => break, () = tokio::time::sleep(backoff) => {} }
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                }
            }
        }
    });
    Ok(hub)
}

#[derive(Clone, Copy)]
enum Scope {
    Mine(Uuid),
    Public,
    All,
    Team(Uuid),
}
// Read-public entities are readable by anyone whatever their visibility flag (records/service.rs),
// so their public stream matches every personal row. Other entities match only public rows.
fn matches(change: &Change, entity: &str, scope: Scope, public_read: bool) -> bool {
    change.entity == entity
        && match scope {
            Scope::Mine(id) => change.team_id.is_none() && change.owner_id == id,
            Scope::Public => {
                change.team_id.is_none() && (public_read || change.visibility == "public")
            }
            Scope::All => change.team_id.is_none(),
            Scope::Team(id) => change.team_id == Some(id),
        }
}
async fn authorized(
    state: &AppState,
    viewer: Option<&Viewer>,
    token: Option<&str>,
    scope: Scope,
    admin_rule: bool,
) -> bool {
    if let Some(v) = viewer {
        let Some(token) = token else {
            return false;
        };
        let Ok(Some(user)) = session::lookup(&state.db, &state.config, token).await else {
            return false;
        };
        if user.status != "active"
            || v.id != user.user_id
            || v.session_id != user.session_id
            || ((matches!(scope, Scope::All) || admin_rule)
                && user.role != "admin"
                && !state
                    .config
                    .admin_emails
                    .contains(&user.email.to_ascii_lowercase()))
        {
            return false;
        }
        if let Scope::Team(team) = scope {
            return teams::require_role(&state.db, team, v, teams::TeamRole::Viewer)
                .await
                .is_ok();
        }
    } else if matches!(scope, Scope::Team(_) | Scope::Mine(_) | Scope::All) {
        return false;
    }
    true
}
// Events can be queued before moderation changes; check the current row before disclosure.
async fn public_event_visible(db: &PgPool, change: &Change, public_read: bool) -> bool {
    sqlx::query_scalar::<_, bool>("select exists(select 1 from records r join users u on u.id=r.owner_id where r.id=$1 and r.entity=$2 and r.team_id is null and ($3 or r.visibility='public') and r.admin_hidden_at is null and r.deleted_at is null and u.deleted_at is null)")
        .bind(change.id).bind(&change.entity).bind(public_read).fetch_one(db).await.unwrap_or(false)
}
// Hidden records show only to their owner and global admins, personal or team. Re-read the row
// because a queued event can predate the moderation change.
async fn hidden_event_visible(db: &PgPool, change: &Change, viewer: Option<&Viewer>) -> bool {
    if viewer.is_some_and(|v| v.is_admin() || v.id == change.owner_id) {
        return true;
    }
    sqlx::query_scalar::<_, bool>("select not exists(select 1 from records where id=$1 and entity=$2 and admin_hidden_at is not null)")
        .bind(change.id).bind(&change.entity).fetch_one(db).await.unwrap_or(false)
}
struct Permit {
    hub: Hub,
    user: Option<Uuid>,
    ip: Option<String>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut counts = self.hub.0.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts.total -= 1;
        if let Some(ip) = &self.ip
            && let Some(count) = counts.anonymous.get_mut(ip)
        {
            *count -= 1;
            if *count == 0 {
                counts.anonymous.remove(ip);
            }
        }
        if let Some(id) = self.user
            && let Some(count) = counts.users.get_mut(&id)
        {
            *count -= 1;
            if *count == 0 {
                counts.users.remove(&id);
            }
        }
    }
}
impl Hub {
    async fn shared_public_visible(
        &self,
        db: &PgPool,
        change: Arc<Change>,
        public_read: bool,
    ) -> bool {
        // Each notification has its own identity. The first subscriber to reach it runs the query;
        // every later subscriber gets the same result while the change is still in flight.
        let key = Arc::as_ptr(&change) as usize;
        let mut rx = {
            let mut cache = self.0.visibility.lock().unwrap_or_else(|e| e.into_inner());
            // Once nothing else holds the change, the broadcast buffer has moved past it and no
            // subscriber can receive it again, so its entry can go.
            cache.retain(|_, entry| Arc::strong_count(&entry.change) > 1);
            if let Some(entry) = cache.get(&key) {
                entry.result.clone()
            } else {
                let (tx, rx) = tokio::sync::watch::channel(None);
                cache.insert(
                    key,
                    VisibilityEntry {
                        change: change.clone(),
                        result: rx.clone(),
                    },
                );
                #[cfg(test)]
                self.0
                    .visibility_queries
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let db = db.clone();
                tokio::spawn(async move {
                    let visible = public_event_visible(&db, &change, public_read).await;
                    let _ = tx.send(Some(visible));
                });
                rx
            }
        };
        loop {
            if let Some(value) = *rx.borrow_and_update() {
                return value;
            }
            if rx.changed().await.is_err() {
                return false;
            }
        }
    }
    fn acquire(&self, user: Option<Uuid>, ip: &str, limit: usize) -> AppResult<Permit> {
        let mut counts = self.0.counts.lock().unwrap_or_else(|e| e.into_inner());
        if counts.total >= 2000
            || user.is_some_and(|id| counts.users.get(&id).copied().unwrap_or(0) >= 5)
            || (user.is_none() && counts.anonymous.get(ip).copied().unwrap_or(0) >= limit)
        {
            return Err(AppError::new(
                ErrorCode::Unavailable,
                "Too many live connections. Please try again shortly.",
            )
            .retry_after(3));
        }
        counts.total += 1;
        if let Some(id) = user {
            *counts.users.entry(id).or_default() += 1;
        }
        let ip = if user.is_none() {
            *counts.anonymous.entry(ip.to_owned()).or_default() += 1;
            Some(ip.to_owned())
        } else {
            None
        };
        Ok(Permit {
            hub: self.clone(),
            user,
            ip,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Params {
    scope: Option<String>,
    team_id: Option<Uuid>,
}
async fn events(
    State(state): State<AppState>,
    Extension(hub): Extension<Hub>,
    Path(entity): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    meta: RequestMeta,
    viewer: Option<Viewer>,
) -> AppResult<Response> {
    let rules = hub
        .0
        .rules
        .get_or_init(|| {
            std::fs::read_to_string(&state.config.entities_path)
                .map_err(|e| e.to_string())
                .and_then(|s| {
                    serde_json::from_str(s.trim_start_matches('\u{feff}'))
                        .map_err(|e| e.to_string())
                })
        })
        .as_ref()
        .map_err(AppError::internal)?;
    let rule = rules.get(&entity).ok_or_else(AppError::not_found)?;
    let requested = params.scope.as_deref().unwrap_or("mine");
    if (requested == "team") != params.team_id.is_some() {
        return Err(AppError::new(ErrorCode::ValidationFailed, "Please check the highlighted fields.")
            .with_details(serde_json::json!([{ "path": "teamId", "message": "Team ID must be used with team scope." }])));
    }
    let scope = match requested {
        "team" => {
            let team = params
                .team_id
                .ok_or_else(|| AppError::bad_request("Team ID is required."))?;
            let user = viewer.as_ref().ok_or_else(AppError::unauthenticated)?;
            teams::require_role(&state.db, team, user, teams::TeamRole::Viewer).await?;
            Scope::Team(team)
        }
        "mine" => Scope::Mine(viewer.as_ref().ok_or_else(AppError::unauthenticated)?.id),
        "public" => {
            // Same rule as REST reads: public records of an entity that allows public visibility (or is
            // public-read) are readable by anyone, so anyone may watch them. Events carry only ids, and
            // the client refetches through REST, which applies the full read rules again.
            if !(rule.allow_public || rule.read == "public") {
                return Err(AppError::not_found());
            }
            Scope::Public
        }
        "all" if viewer.as_ref().is_some_and(Viewer::is_admin) => Scope::All,
        "all" if viewer.is_none() => return Err(AppError::unauthenticated()),
        "all" => return Err(AppError::forbidden()),
        _ => return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please choose a valid scope.",
        )
        .with_details(
            serde_json::json!([{ "path": "scope", "message": "Use mine, public, or all." }]),
        )),
    };
    if rule.read == "admin" && !viewer.as_ref().is_some_and(Viewer::is_admin) {
        return Err(AppError::not_found());
    }
    let token = viewer.as_ref().and_then(|v| {
        if v.via_cookie {
            session::read_cookie(&headers, &state.config.session_cookie).map(str::to_owned)
        } else {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|h| h.strip_prefix("Bearer "))
                .map(|s| s.trim().to_owned())
        }
    });
    if viewer.is_some() && token.is_none() {
        return Err(AppError::unauthenticated());
    }
    let admin_rule = rule.read == "admin";
    let public_read = rule.read == "public";
    let permit = hub.acquire(
        viewer.as_ref().map(|v| v.id),
        &meta.ip,
        state.config.anonymous_sse_per_ip,
    )?;
    let mut rx = hub.0.tx.subscribe();
    let stream = async_stream::stream! {
        let _permit = permit;
        yield Ok::<Event, Infallible>(Event::default().retry(Duration::from_secs(3)));
        let expiry = tokio::time::sleep(Duration::from_secs(1800));
        tokio::pin!(expiry);
        let mut check = tokio::time::interval_at(tokio::time::Instant::now() + SESSION_RECHECK, SESSION_RECHECK);
        loop {
            tokio::select! {
                () = &mut expiry => break,
                _ = check.tick() => {
                    if !authorized(&state, viewer.as_ref(), token.as_deref(), scope, admin_rule).await { break; }
                    yield Ok(Event::default().comment(""));
                }
                message = rx.recv() => match message {
                    Ok(Message::Change(change)) if matches(&change, &entity, scope, public_read) => {
                        if !authorized(&state, viewer.as_ref(), token.as_deref(), scope, admin_rule).await { break; }
                        if matches!(scope, Scope::Public) && !hub.shared_public_visible(&state.db, change.clone(), public_read).await { continue; }
                        if matches!(scope, Scope::Team(_)) && !hidden_event_visible(&state.db, &change, viewer.as_ref()).await { continue; }
                        let payload = PublicChange { id: change.id, entity: &change.entity, op: &change.op, version: change.version };
                        if let Ok(data) = serde_json::to_string(&payload) { yield Ok(Event::default().event("change").data(data)); }
                    }
                    Ok(Message::Resync) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        if !authorized(&state, viewer.as_ref(), token.as_deref(), scope, admin_rule).await { break; }
                        yield Ok(Event::default().event("resync").data("{}"));
                    },
                    Err(broadcast::error::RecvError::Closed) => break,
                    _ => {},
                }
            }
        }
    };
    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
/// Routes mounted under `/api/v1`.
pub fn router() -> Router<AppState> {
    Router::new().route("/entities/{entity}/events", get(events))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[sqlx::test(migrations = "../../migrations")]
    async fn public_events_check_current_moderation_state(db: PgPool) {
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('stream-hidden@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let change = Change {
            id,
            entity: "notes".into(),
            owner_id: owner,
            team_id: None,
            visibility: "public".into(),
            version: 1,
            op: "update".into(),
        };
        assert!(public_event_visible(&db, &change, false).await);
        sqlx::query("update records set admin_hidden_at=now() where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(!public_event_visible(&db, &change, false).await);
        sqlx::query("update records set admin_hidden_at=null,visibility='private' where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(!public_event_visible(&db, &change, false).await);
        assert!(public_event_visible(&db, &change, true).await);
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        // Each notification is its own Arc. Subscribers share the first read of one notification,
        // so a later moderation change is seen by the next notification, not by a re-read.
        let notify = || Arc::new(change.clone());
        assert!(hub.shared_public_visible(&db, notify(), true).await);
        sqlx::query("update records set admin_hidden_at=now() where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(!hub.shared_public_visible(&db, notify(), true).await);
        sqlx::query("update records set admin_hidden_at=null,deleted_at=now() where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(!hub.shared_public_visible(&db, notify(), true).await);
        let _ = stop.send(());
        assert!(matches(&change, "notes", Scope::Mine(owner), false));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn hidden_team_events_reach_only_owner_and_admins(db: PgPool) {
        use kernel::viewer::Role;
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('hidden-team-owner@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let member: Uuid = sqlx::query_scalar(
            "insert into users(email) values('hidden-team-member@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Hidden','hidden-team',$1) returning id",
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
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data,visibility,admin_hidden_at) values('notes',$1,$2,'{}','private',now()) returning id").bind(owner).bind(team).fetch_one(&db).await.unwrap();
        let change = Change {
            id,
            entity: "notes".into(),
            owner_id: owner,
            team_id: Some(team),
            visibility: "private".into(),
            version: 1,
            op: "update".into(),
        };
        let viewer = |id: Uuid, role: Role| Viewer {
            id,
            session_id: Uuid::new_v4(),
            email: String::new(),
            display_name: String::new(),
            role,
            via_cookie: false,
        };
        assert!(!hidden_event_visible(&db, &change, Some(&viewer(member, Role::User))).await);
        assert!(!hidden_event_visible(&db, &change, None).await);
        assert!(hidden_event_visible(&db, &change, Some(&viewer(owner, Role::User))).await);
        assert!(hidden_event_visible(&db, &change, Some(&viewer(member, Role::Admin))).await);
        sqlx::query("update records set admin_hidden_at=null where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(hidden_event_visible(&db, &change, Some(&viewer(member, Role::User))).await);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn public_stream_skips_hidden_records(db: PgPool) {
        use futures::StreamExt;
        use kernel::{config::Config, email::LogSender};
        use tokio::sync::Semaphore;
        let mut config = Config::from_env().unwrap();
        config.entities_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../config/entities.json").into();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(Semaphore::new(1)),
        };
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('public-stream@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        assert!(
            hub.0
                .rules
                .set(Ok(HashMap::from([(
                    "notes".into(),
                    EntityRule {
                        read: "public".into(),
                        allow_public: false
                    }
                )])))
                .is_ok()
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router().layer(Extension(hub.clone())).with_state(state);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            reqwest::get(format!(
                "http://{address}/entities/notes/events?scope=public"
            )),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let mut stream = response.bytes_stream();
        let ready = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&ready).contains("retry:"));
        let private: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','private') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&event).contains(&private.to_string()));
        // A hidden public insert is queued before the visible one; the stream must skip it.
        let hidden: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility,admin_hidden_at) values('notes',$1,'{}','public',now()) returning id").bind(owner).fetch_one(&db).await.unwrap();
        let visible: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let first = String::from_utf8_lossy(&first).into_owned();
        assert!(first.contains(&visible.to_string()));
        assert!(!first.contains(&hidden.to_string()));
        // Hiding a visible record must stop its events too.
        sqlx::query("update records set admin_hidden_at=now(),version=2 where id=$1")
            .bind(visible)
            .execute(&db)
            .await
            .unwrap();
        let later: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let next = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let next = String::from_utf8_lossy(&next).into_owned();
        assert!(next.contains(&later.to_string()));
        assert!(!next.contains(&visible.to_string()));
        server.abort();
        let _ = stop.send(());
    }
    #[test]
    fn filters_by_entity_owner_and_visibility() {
        let owner = Uuid::new_v4();
        let change = Change {
            id: Uuid::new_v4(),
            entity: "notes".into(),
            owner_id: owner,
            team_id: None,
            visibility: "private".into(),
            version: 1,
            op: "insert".into(),
        };
        assert!(matches(&change, "notes", Scope::Mine(owner), false));
        assert!(!matches(
            &change,
            "notes",
            Scope::Mine(Uuid::new_v4()),
            false
        ));
        assert!(!matches(&change, "notes", Scope::Public, false));
        assert!(!matches(&change, "tasks", Scope::All, false));
        let team = Uuid::new_v4();
        let mut team_change = change.clone();
        team_change.team_id = Some(team);
        team_change.visibility = "public".into();
        assert!(matches(&team_change, "notes", Scope::Team(team), false));
        assert!(!matches(
            &team_change,
            "notes",
            Scope::Team(Uuid::new_v4()),
            false
        ));
        assert!(!matches(&team_change, "notes", Scope::Mine(owner), false));
        assert!(!matches(&team_change, "notes", Scope::Public, false));
        assert!(!matches(&team_change, "notes", Scope::All, false));
        assert!(serde_json::from_str::<Change>(&format!(r#"{{"id":"{}","entity":"notes","ownerId":"{}","visibility":"public","version":1,"op":"insert"}}"#, Uuid::new_v4(), owner)).is_err());
    }
    #[test]
    fn session_recheck_runs_every_minute() {
        assert_eq!(SESSION_RECHECK, Duration::from_secs(60));
    }
    // Read-public entities are readable by anyone whatever the flag says, so their public stream
    // matches a private row. Entities that only allow public visibility still need the flag.
    #[test]
    fn read_public_entity_matches_private_row_on_public_scope() {
        let change = Change {
            id: Uuid::new_v4(),
            entity: "notes".into(),
            owner_id: Uuid::new_v4(),
            team_id: None,
            visibility: "private".into(),
            version: 1,
            op: "insert".into(),
        };
        assert!(matches(&change, "notes", Scope::Public, true));
        assert!(!matches(&change, "notes", Scope::Public, false));
        let mut team_change = change.clone();
        team_change.team_id = Some(Uuid::new_v4());
        assert!(!matches(&team_change, "notes", Scope::Public, true));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn read_public_private_row_reaches_public_stream_but_allow_public_private_row_does_not(
        db: PgPool,
    ) {
        use futures::StreamExt;
        use kernel::{config::Config, email::LogSender};
        use tokio::sync::Semaphore;
        let mut config = Config::from_env().unwrap();
        config.entities_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../config/entities.json").into();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(Semaphore::new(1)),
        };
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('read-public-stream@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        assert!(
            hub.0
                .rules
                .set(Ok(HashMap::from([
                    (
                        "notes".into(),
                        EntityRule {
                            read: "public".into(),
                            allow_public: false,
                        },
                    ),
                    (
                        "tasks".into(),
                        EntityRule {
                            read: "owner".into(),
                            allow_public: true,
                        },
                    ),
                ])))
                .is_ok()
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router().layer(Extension(hub.clone())).with_state(state);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // Anonymous public streams, one per entity.
        let open = |entity: &'static str| {
            let url = format!("http://{address}/entities/{entity}/events?scope=public");
            async move {
                let response = tokio::time::timeout(Duration::from_secs(5), reqwest::get(url))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::OK);
                let mut stream = response.bytes_stream();
                let ready = tokio::time::timeout(Duration::from_secs(5), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(String::from_utf8_lossy(&ready).contains("retry:"));
                stream
            }
        };
        let mut notes = open("notes").await;
        let mut tasks = open("tasks").await;
        // read: public -> the private-flag row is delivered to the anonymous public stream.
        let private_note: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','private') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), notes.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&event).contains(&private_note.to_string()));
        // allowPublic only -> the private-flag row is skipped; the public row after it is the first event.
        let private_task: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('tasks',$1,'{}','private') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let public_task: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('tasks',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), tasks.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event = String::from_utf8_lossy(&event).into_owned();
        assert!(event.contains(&public_task.to_string()));
        assert!(!event.contains(&private_task.to_string()));
        server.abort();
        let _ = stop.send(());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn one_visibility_query_serves_every_subscriber_of_a_change(db: PgPool) {
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('fanout@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        let change = Arc::new(Change {
            id,
            entity: "notes".into(),
            owner_id: owner,
            team_id: None,
            visibility: "public".into(),
            version: 1,
            op: "insert".into(),
        });
        // Five subscribers each receive a clone of the same Arc, as the broadcast channel delivers it.
        let mut subscribers: Vec<_> = (0..5).map(|_| hub.0.tx.subscribe()).collect();
        assert_eq!(hub.0.tx.send(Message::Change(change.clone())).ok(), Some(5));
        drop(change);
        let mut results = Vec::new();
        for subscriber in &mut subscribers {
            let Ok(Message::Change(received)) = subscriber.recv().await else {
                panic!("expected the change");
            };
            results.push(hub.shared_public_visible(&db, received, true).await);
        }
        assert_eq!(results, [true; 5]);
        assert_eq!(
            hub.0
                .visibility_queries
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let _ = stop.send(());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn access_and_user_stream_limit(db: PgPool) {
        use kernel::{config::Config, email::LogSender};
        use tokio::sync::Semaphore;
        let mut config = Config::from_env().unwrap();
        config.entities_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../config/entities.json").into();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(Semaphore::new(1)),
        };
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        let query = || {
            Query(Params {
                scope: None,
                team_id: None,
            })
        };
        let err = events(
            State(state.clone()),
            Extension(hub.clone()),
            Path("notes".into()),
            query(),
            HeaderMap::new(),
            RequestMeta {
                ip: "127.0.0.1".into(),
                user_agent: String::new(),
                request_id: String::new(),
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unauthenticated);
        let err = events(
            State(state),
            Extension(hub.clone()),
            Path("missing".into()),
            query(),
            HeaderMap::new(),
            RequestMeta {
                ip: "127.0.0.1".into(),
                user_agent: String::new(),
                request_id: String::new(),
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let user = Uuid::new_v4();
        let permits: Vec<_> = (0..5)
            .map(|_| hub.acquire(Some(user), "127.0.0.1", 5).unwrap())
            .collect();
        assert!(hub.acquire(Some(user), "127.0.0.1", 5).is_err());
        assert!(hub.acquire(Some(Uuid::new_v4()), "127.0.0.1", 5).is_ok());
        drop(permits);
        assert!(hub.acquire(Some(user), "127.0.0.1", 5).is_ok());
        let anonymous: Vec<_> = (0..5)
            .map(|_| hub.acquire(None, "192.0.2.1", 5).unwrap())
            .collect();
        assert!(hub.acquire(None, "192.0.2.1", 5).is_err());
        assert!(hub.acquire(None, "192.0.2.2", 5).is_ok());
        drop(anonymous);
        assert!(hub.acquire(None, "192.0.2.1", 5).is_ok());
        assert!(
            !hub.0
                .counts
                .lock()
                .unwrap()
                .anonymous
                .contains_key("192.0.2.2")
        );
        let _ = stop.send(());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn notifications_include_only_metadata(db: PgPool) {
        let mut listener = PgListener::connect_with(&db).await.unwrap();
        listener.listen("records_changed").await.unwrap();
        let owner: Uuid =
            sqlx::query_scalar("insert into users (email) values ('a@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let id: Uuid = sqlx::query_scalar("insert into records (entity, owner_id, data) values ('notes', $1, '{\"secret\":\"hidden\"}') returning id").bind(owner).fetch_one(&db).await.unwrap();
        for operation in ["insert", "update", "delete"] {
            if operation == "update" {
                sqlx::query("update records set version = 2 where id = $1")
                    .bind(id)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            if operation == "delete" {
                sqlx::query("update records set deleted_at = now(), version = 3 where id = $1")
                    .bind(id)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            let note = tokio::time::timeout(Duration::from_secs(5), listener.recv())
                .await
                .unwrap()
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(note.payload()).unwrap();
            assert_eq!(value["op"], operation);
            assert_eq!(value["id"], id.to_string());
            assert_eq!(value["ownerId"], owner.to_string());
            assert!(value.get("data").is_none());
            assert_eq!(value.as_object().unwrap().len(), 7);
        }
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn live_streams_isolate_teams_and_close_after_revocation(db: PgPool) {
        use futures::StreamExt;
        use kernel::{config::Config, email::LogSender, request::RequestMeta};
        use tokio::sync::Semaphore;
        let mut config = Config::from_env().unwrap();
        config.entities_path =
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../config/entities.json").into();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(Semaphore::new(1)),
        };
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email) values('stream@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Stream','stream',$1) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        let other: Uuid = sqlx::query_scalar("insert into teams(name,slug,created_by) values('Other','stream-other',$1) returning id").bind(owner).fetch_one(&db).await.unwrap();
        sqlx::query(
            "insert into team_members(team_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')",
        )
        .bind(team)
        .bind(other)
        .bind(owner)
        .execute(&db)
        .await
        .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, session_id) = session::create(&db, &state.config, owner, &meta)
            .await
            .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let hub = spawn_listener(db.clone(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router()
            .layer(Extension(hub.clone()))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let mut streams = Vec::new();
        for (scope, team_id) in [
            ("team", Some(team)),
            ("team", Some(other)),
            ("mine", None),
            ("public", None),
        ] {
            let mut url = format!("http://{address}/entities/notes/events?scope={scope}");
            if let Some(id) = team_id {
                url.push_str(&format!("&teamId={id}"));
            }
            let response = tokio::time::timeout(
                Duration::from_secs(5),
                client.get(url).bearer_auth(&token).send(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            let mut stream = response.bytes_stream();
            let ready = tokio::time::timeout(Duration::from_secs(5), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(String::from_utf8_lossy(&ready).contains("retry:"));
            streams.push(stream);
        }
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data,visibility) values('notes',$1,$2,'{}','private') returning id").bind(owner).bind(team).fetch_one(&db).await.unwrap();
        for operation in ["insert", "update", "delete"] {
            if operation == "update" {
                sqlx::query("update records set version=2 where id=$1")
                    .bind(id)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            if operation == "delete" {
                sqlx::query("update records set deleted_at=now(),version=3 where id=$1")
                    .bind(id)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            let bytes = tokio::time::timeout(Duration::from_secs(5), streams[0].next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let event = String::from_utf8_lossy(&bytes);
            assert!(event.contains(&id.to_string()) && event.contains(operation));
        }
        for stream in &mut streams[1..] {
            assert!(
                tokio::time::timeout(Duration::from_millis(200), stream.next())
                    .await
                    .is_err()
            );
        }
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update records set version=4 where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), streams[0].next())
                .await
                .unwrap()
                .is_none()
        );
        sqlx::query("update sessions set expires_at=now()-interval '1 second' where id=$1")
            .bind(session_id)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into records(entity,owner_id,team_id,data) values('notes',$1,$2,'{}')")
            .bind(owner)
            .bind(other)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), streams[1].next())
                .await
                .unwrap()
                .is_none()
        );
        server.abort();
        let _ = stop.send(());
    }
}
