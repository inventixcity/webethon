use super::*;
use axum::response::sse::{Event, Sse};
use futures::Stream;
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::broadcast;

const BUFFER: usize = 256;
const MAX_STREAMS: usize = 1024;
const MAX_PER_USER: usize = 4;
const MAX_DATABASES: usize = 64;

#[derive(Clone, Debug)]
enum Notice {
    Id(Uuid, Uuid),
    Resync,
}
struct Hub {
    sender: broadcast::Sender<Notice>,
    users: Mutex<HashMap<Uuid, usize>>,
}
static HUBS: OnceLock<Mutex<HashMap<String, Weak<Hub>>>> = OnceLock::new();
struct Subscription {
    hub: Arc<Hub>,
    user: Uuid,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ok(mut users) = self.hub.users.lock()
            && let Some(count) = users.get_mut(&self.user)
        {
            *count -= 1;
            if *count == 0 {
                users.remove(&self.user);
            }
        }
    }
}
fn subscribe(
    db: &sqlx::PgPool,
    user: Uuid,
) -> AppResult<(Subscription, broadcast::Receiver<Notice>)> {
    let opts = db.connect_options();
    let key = format!(
        "{}:{}:{}:{}",
        opts.get_host(),
        opts.get_port(),
        opts.get_database().unwrap_or(""),
        opts.get_username()
    );
    let mut hubs = HUBS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(AppError::internal)?;
    hubs.retain(|_, hub| hub.strong_count() > 0);
    let hub = if let Some(hub) = hubs.get(&key).and_then(Weak::upgrade) {
        hub
    } else {
        if hubs.len() >= MAX_DATABASES {
            return Err(AppError::new(
                ErrorCode::Unavailable,
                "Please try again shortly.",
            ));
        }
        let (sender, _) = broadcast::channel(BUFFER);
        let hub = Arc::new(Hub {
            sender,
            users: Mutex::new(HashMap::new()),
        });
        hubs.insert(key, Arc::downgrade(&hub));
        tokio::spawn(listen(db.clone(), Arc::downgrade(&hub)));
        hub
    };
    {
        let mut users = hub.users.lock().map_err(AppError::internal)?;
        if users.values().sum::<usize>() >= MAX_STREAMS
            || users.get(&user).copied().unwrap_or(0) >= MAX_PER_USER
        {
            return Err(AppError::new(
                ErrorCode::RateLimited,
                "Too many open notification streams.",
            )
            .retry_after(15));
        }
        *users.entry(user).or_default() += 1;
    }
    let receiver = hub.sender.subscribe();
    Ok((Subscription { hub, user }, receiver))
}
async fn listen(db: sqlx::PgPool, hub: Weak<Hub>) {
    let mut delay = Duration::from_secs(1);
    loop {
        if hub.strong_count() == 0 || db.is_closed() {
            break;
        }
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            sqlx::postgres::PgListener::connect_with(&db),
        )
        .await;
        if let Ok(Ok(mut listener)) = connection
            && matches!(
                tokio::time::timeout(
                    Duration::from_secs(10),
                    listener.listen("social_notifications")
                )
                .await,
                Ok(Ok(()))
            )
        {
            if let Some(h) = hub.upgrade() {
                let _ = h.sender.send(Notice::Resync);
            } else {
                break;
            }
            delay = Duration::from_secs(1);
            loop {
                if hub.strong_count() == 0 || db.is_closed() {
                    return;
                }
                match tokio::time::timeout(Duration::from_secs(1), listener.try_recv()).await {
                    Ok(Ok(Some(message))) => {
                        #[derive(Deserialize)]
                        #[serde(rename_all = "camelCase", deny_unknown_fields)]
                        struct Payload {
                            recipient_id: Uuid,
                            notification_id: Uuid,
                        }
                        if let Ok(payload) = serde_json::from_str::<Payload>(message.payload()) {
                            if let Some(h) = hub.upgrade() {
                                let _ = h.sender.send(Notice::Id(
                                    payload.recipient_id,
                                    payload.notification_id,
                                ));
                            } else {
                                return;
                            }
                        }
                    }
                    Ok(Ok(None)) => {
                        if let Some(h) = hub.upgrade() {
                            let _ = h.sender.send(Notice::Resync);
                        } else {
                            return;
                        }
                    }
                    Ok(Err(_)) => break,
                    Err(_) => {}
                }
            }
        }
        if let Some(h) = hub.upgrade() {
            let _ = h.sender.send(Notice::Resync);
        } else {
            break;
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}
async fn current(s: &AppState, v: &Viewer) -> AppResult<Option<Viewer>> {
    let row: Option<(String, String, String)> = sqlx::query_as("select u.email::text,u.display_name,u.role from sessions s join users u on u.id=s.user_id where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>now() and u.deleted_at is null and u.status='active'")
        .bind(v.session_id).bind(v.id).fetch_optional(&s.db).await?;
    Ok(row.map(|(email, display_name, role)| Viewer {
        id: v.id,
        session_id: v.session_id,
        role: if role == "admin" || s.config.admin_emails.contains(&email.to_ascii_lowercase()) {
            kernel::viewer::Role::Admin
        } else {
            kernel::viewer::Role::User
        },
        email,
        display_name,
        via_cookie: v.via_cookie,
    }))
}
pub(super) fn router() -> Router<AppState> {
    Router::new().route("/notifications/events", get(events))
}
async fn events(
    State(s): State<AppState>,
    Extension(r): Extension<Arc<EntityRegistry>>,
    v: Viewer,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let (subscription, mut receiver) = subscribe(&s.db, v.id)?;
    let stream = async_stream::stream! {
        let _subscription = subscription;
        yield Ok(Event::default().event("resync").data("{}"));
        let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(15), Duration::from_secs(15));
        loop {
            tokio::select! {
                notice = receiver.recv() => {
                    let notice = match notice { Ok(n) => n, Err(broadcast::error::RecvError::Lagged(_)) => Notice::Resync, Err(broadcast::error::RecvError::Closed) => break };
                    if matches!(notice, Notice::Id(recipient, _) if recipient != v.id) { continue; }
                    let viewer = match current(&s, &v).await { Ok(Some(viewer)) => viewer, _ => break };
                    match notice {
                        Notice::Resync => yield Ok(Event::default().event("resync").data("{}")),
                        Notice::Id(_, id) => match inbox::notification_by_id(&s, &r, &viewer, id).await {
                            Ok(Some(item)) => yield Ok(Event::default().event("notification").data(json!({"notification":item}).to_string())),
                            Ok(None) => {}, Err(_) => break,
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    if !matches!(current(&s, &v).await, Ok(Some(_))) { break; }
                    yield Ok(Event::default().comment("heartbeat"));
                }
            }
        }
    };
    Ok(Sse::new(stream))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, response::IntoResponse};
    use futures::StreamExt;
    use kernel::{config::Config, email::LogSender, session};
    use tower::ServiceExt;
    async fn new_user(db: &sqlx::PgPool, config: &Config) -> (Uuid, String, Uuid) {
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
        let (token, session) = session::create(db, config, id, &meta).await.unwrap();
        (id, token, session)
    }
    async fn next(
        stream: &mut (impl Stream<Item = Result<axum::body::Bytes, axum::Error>> + Unpin),
    ) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .map(|x| String::from_utf8(x.unwrap().to_vec()).unwrap())
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn stream_cap_returns_retry_after(db: sqlx::PgPool) {
        let user = Uuid::new_v4();
        let subscriptions: Vec<_> = (0..MAX_PER_USER)
            .map(|_| subscribe(&db, user).unwrap())
            .collect();
        let error = match subscribe(&db, user) {
            Err(error) => error,
            Ok(_) => panic!("stream cap was not enforced"),
        };
        let response = error.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "15");
        drop(subscriptions);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn live_delivery_privacy_and_revocation(db: sqlx::PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let state = AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let definition = json!({"label":"Note","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{}},"social":{"comments":true,"reactions":["like"],"bookmarks":true}});
        let registry =
            Arc::new(EntityRegistry::from_json(&json!({"notes":definition}).to_string()).unwrap());
        let app = super::super::router()
            .layer(Extension(registry.clone()))
            .with_state(state.clone());
        let (owner, token, session_id) = new_user(&db, &config).await;
        let (actor, _, _) = new_user(&db, &config).await;
        let (_, other_token, _) = new_user(&db, &config).await;
        let open = |token: String| {
            let app = app.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .uri("/notifications/events")
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .into_body()
                .into_data_stream()
            }
        };
        let mut recipient = open(token).await;
        let mut other = open(other_token).await;
        assert!(next(&mut recipient).await.unwrap().contains("resync"));
        assert!(next(&mut other).await.unwrap().contains("resync"));
        // Listener announces readiness after LISTEN, so no notification can race startup here.
        assert!(next(&mut recipient).await.unwrap().contains("resync"));
        // The second stream may subscribe before or after listener readiness.
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let id: Uuid = sqlx::query_scalar("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,reaction_kind) values($1,'reaction',$2,'notes',$3,'like') returning id").bind(owner).bind(actor).bind(record).fetch_one(&db).await.unwrap();
        let delivered = next(&mut recipient).await.unwrap();
        assert!(delivered.contains("event: notification"));
        assert!(delivered.contains(&id.to_string()));
        // Drain a possible readiness event, then no other recipient may receive the ID.
        if let Ok(Some(Ok(bytes))) =
            tokio::time::timeout(Duration::from_millis(300), other.next()).await
        {
            assert!(
                String::from_utf8(bytes.to_vec())
                    .unwrap()
                    .contains("resync")
            );
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(300), other.next())
                .await
                .is_err()
        );
        sqlx::query("update records set visibility='private' where id=$1")
            .bind(record)
            .execute(&db)
            .await
            .unwrap();
        let (sub, _) = subscribe(&db, owner).unwrap();
        sub.hub.sender.send(Notice::Id(owner, id)).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(300), recipient.next())
                .await
                .is_err()
        );
        for _ in 0..(BUFFER + 1) {
            sub.hub.sender.send(Notice::Resync).unwrap();
        }
        assert!(
            next(&mut recipient)
                .await
                .unwrap()
                .contains("event: resync")
        );
        sqlx::query("update sessions set revoked_at=now() where id=$1")
            .bind(session_id)
            .execute(&db)
            .await
            .unwrap();
        sub.hub.sender.send(Notice::Id(owner, id)).unwrap();
        assert!(next(&mut recipient).await.is_none());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn team_stream_rechecks_actor_membership(db: sqlx::PgPool) {
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
        let app = super::super::router()
            .layer(Extension(registry))
            .with_state(state);
        let (owner, token, _) = new_user(&db, &config).await;
        let (actor, _, _) = new_user(&db, &config).await;
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Team','stream-team',$1) returning id",
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
        .bind(actor)
        .execute(&db)
        .await
        .unwrap();
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data,visibility) values('notes',$1,$2,'{}','private') returning id").bind(owner).bind(team).fetch_one(&db).await.unwrap();
        let mut stream = app
            .oneshot(
                Request::builder()
                    .uri("/notifications/events")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .into_body()
            .into_data_stream();
        assert!(next(&mut stream).await.unwrap().contains("resync"));
        assert!(next(&mut stream).await.unwrap().contains("resync"));
        let id: Uuid = sqlx::query_scalar("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,reaction_kind) values($1,'reaction',$2,'notes',$3,'like') returning id").bind(owner).bind(actor).bind(record).fetch_one(&db).await.unwrap();
        assert!(next(&mut stream).await.unwrap().contains(&id.to_string()));
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(actor)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,reaction_kind) values($1,'reaction',$2,'notes',$3,'like')").bind(owner).bind(actor).bind(record).execute(&db).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(500), stream.next())
                .await
                .is_err()
        );
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn hidden_comment_notifications_are_not_streamed(db: sqlx::PgPool) {
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
        let app = super::super::router()
            .layer(Extension(registry))
            .with_state(state);
        let (owner, token, _) = new_user(&db, &config).await;
        let (actor, _, _) = new_user(&db, &config).await;
        let record: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,data,visibility) values('notes',$1,'{}','public') returning id").bind(owner).fetch_one(&db).await.unwrap();
        let shown_comment: Uuid = sqlx::query_scalar("insert into social_comments(entity,record_id,author_id,body) values('notes',$1,$2,'visible') returning id").bind(record).bind(actor).fetch_one(&db).await.unwrap();
        let hidden_comment: Uuid = sqlx::query_scalar("insert into social_comments(entity,record_id,author_id,body,admin_hidden_at) values('notes',$1,$2,'secret',now()) returning id").bind(record).bind(actor).fetch_one(&db).await.unwrap();
        let mut stream = app
            .oneshot(
                Request::builder()
                    .uri("/notifications/events")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .into_body()
            .into_data_stream();
        assert!(next(&mut stream).await.unwrap().contains("resync"));
        assert!(next(&mut stream).await.unwrap().contains("resync"));
        // Positive control: a visible comment's notification is delivered, so the pipeline works.
        let shown: Uuid = sqlx::query_scalar("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,comment_id) values($1,'comment',$2,'notes',$3,$4) returning id").bind(owner).bind(actor).bind(record).bind(shown_comment).fetch_one(&db).await.unwrap();
        let delivered = next(&mut stream).await.unwrap();
        assert!(delivered.contains("event: notification"));
        assert!(delivered.contains(&shown.to_string()));
        // A notification for the hidden comment must not reach the live stream.
        let _hidden: Uuid = sqlx::query_scalar("insert into social_notifications(recipient_id,kind,actor_id,entity,record_id,comment_id) values($1,'comment',$2,'notes',$3,$4) returning id").bind(owner).bind(actor).bind(record).bind(hidden_comment).fetch_one(&db).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(800), stream.next())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn hubs_are_isolated_and_released() {
        let options = sqlx::postgres::PgPoolOptions::new();
        let first = options
            .clone()
            .connect_lazy("postgres://postgres:postgres@localhost/first_social_test")
            .unwrap();
        let second = options
            .connect_lazy("postgres://postgres:postgres@localhost/second_social_test")
            .unwrap();
        let user = Uuid::new_v4();
        let (one, mut receiver_one) = subscribe(&first, user).unwrap();
        let (two, mut receiver_two) = subscribe(&second, user).unwrap();
        one.hub
            .sender
            .send(Notice::Id(user, Uuid::new_v4()))
            .unwrap();
        assert!(matches!(receiver_one.try_recv(), Ok(Notice::Id(_, _))));
        assert!(matches!(
            receiver_two.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let weak = Arc::downgrade(&one.hub);
        drop(one);
        drop(receiver_one);
        assert!(weak.upgrade().is_none());
        drop(two);
    }
    #[tokio::test]
    async fn lag_is_bounded_and_signalled() {
        let (sender, mut receiver) = broadcast::channel(2);
        for _ in 0..4 {
            sender.send(Notice::Resync).unwrap();
        }
        assert!(matches!(
            receiver.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
    }
}
