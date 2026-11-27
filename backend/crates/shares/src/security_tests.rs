use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
    response::Response,
};
use kernel::{config::Config, email::LogSender, viewer::Role};
use sqlx::PgPool;
use tower::ServiceExt;

struct Fixture {
    db: PgPool,
    app: Router,
    owner: Uuid,
    stranger: Uuid,
    record: Uuid,
}

impl Fixture {
    async fn new(db: PgPool) -> Self {
        let state = AppState {
            db: db.clone(),
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let registry = Arc::new(EntityRegistry::from_json(&json!({"notes":{"label":"Notes","read":"owner","create":"authenticated","write":"owner","allowPublic":false,"maxPerOwner":20,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"title":{"type":"string","maxLength":100}},"required":["title"]}}}).to_string()).unwrap());
        let owner = Self::user(&db).await;
        let stranger = Self::user(&db).await;
        let record = sqlx::query_scalar(
            "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
        )
        .bind(owner)
        .bind(json!({"title":"hello"}))
        .fetch_one(&db)
        .await
        .unwrap();
        Self {
            db,
            app: router().layer(Extension(registry)).with_state(state),
            owner,
            stranger,
            record,
        }
    }
    async fn user(db: &PgPool) -> Uuid {
        sqlx::query_scalar("insert into users(email) values($1) returning id")
            .bind(format!("{}@example.com", Uuid::new_v4()))
            .fetch_one(db)
            .await
            .unwrap()
    }
    async fn request(
        &self,
        method: Method,
        uri: &str,
        user: Option<Uuid>,
        body: Option<Value>,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.map_or_else(String::new, |v| v.to_string())))
            .unwrap();
        if let Some(id) = user {
            request.extensions_mut().insert(Viewer {
                id,
                session_id: Uuid::new_v4(),
                email: String::new(),
                display_name: String::new(),
                role: Role::User,
                via_cookie: false,
            });
        }
        self.app.clone().oneshot(request).await.unwrap()
    }
    async fn create(&self, user: Uuid, entity: &str, days: Option<i32>) -> Response {
        self.request(
            Method::POST,
            "/shares",
            Some(user),
            Some(json!({"entity":entity,"recordId":self.record,"expiresInDays":days})),
        )
        .await
    }
    async fn create_link(&self, user: Uuid) -> (Uuid, String) {
        let response = self.create(user, "notes", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        (
            Uuid::parse_str(body["data"]["id"].as_str().unwrap()).unwrap(),
            body["data"]["url"]
                .as_str()
                .unwrap()
                .rsplit('/')
                .next()
                .unwrap()
                .to_owned(),
        )
    }
    async fn public(&self, token: &str, status: StatusCode) -> Value {
        let response = self
            .request(Method::GET, &format!("/public/shares/{token}"), None, None)
            .await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-robots-tag"], "noindex");
        json_body(response).await
    }
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn public_visibility_and_token_storage(db: PgPool) {
    let f = Fixture::new(db).await;
    assert_eq!(
        f.create(f.stranger, "notes", None).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.create(f.owner, "unknown", None).await.status(),
        StatusCode::NOT_FOUND
    );
    let (id, token) = f.create_link(f.owner).await;
    let hash: Vec<u8> = sqlx::query_scalar("select token_hash from shares where id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(hash, crypto::hash_token(&token).unwrap());
    assert_ne!(hash, token.as_bytes());
    let body = f.public(&token, StatusCode::OK).await;
    assert_eq!(
        body,
        json!({"data":{"id":f.record,"data":{"title":"hello"}}})
    );
    for (column, value) in [("admin_hidden_at", "now()"), ("deleted_at", "now()")] {
        sqlx::query(&format!("update records set {column}={value} where id=$1"))
            .bind(f.record)
            .execute(&f.db)
            .await
            .unwrap();
        f.public(&token, StatusCode::NOT_FOUND).await;
        sqlx::query(&format!("update records set {column}=null where id=$1"))
            .bind(f.record)
            .execute(&f.db)
            .await
            .unwrap();
    }
    for sql in [
        "update users set status='suspended' where id=$1",
        "update users set deleted_at=now() where id=$1",
    ] {
        sqlx::query(sql).bind(f.owner).execute(&f.db).await.unwrap();
        f.public(&token, StatusCode::NOT_FOUND).await;
        sqlx::query("update users set status='active',deleted_at=null where id=$1")
            .bind(f.owner)
            .execute(&f.db)
            .await
            .unwrap();
    }
    sqlx::query("update records set entity='removed' where id=$1")
        .bind(f.record)
        .execute(&f.db)
        .await
        .unwrap();
    f.public(&token, StatusCode::NOT_FOUND).await;
    sqlx::query("update records set entity='notes' where id=$1")
        .bind(f.record)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("update shares set expires_at=now()-interval '1 second' where id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    f.public(&token, StatusCode::NOT_FOUND).await;
    sqlx::query("update shares set expires_at=now()+interval '1 day' where id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            Method::DELETE,
            &format!("/shares/{id}"),
            Some(f.stranger),
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(
            Method::DELETE,
            &format!("/shares/{id}"),
            Some(f.owner),
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
    f.public(&token, StatusCode::NOT_FOUND).await;
    f.public("invalid", StatusCode::NOT_FOUND).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_authority_changes_invalidate_links(db: PgPool) {
    let f = Fixture::new(db).await;
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Team',$1,$2) returning id",
    )
    .bind(format!("team-{}", Uuid::new_v4()))
    .bind(f.owner)
    .fetch_one(&f.db)
    .await
    .unwrap();
    sqlx::query("update records set team_id=$1 where id=$2")
        .bind(team)
        .bind(f.record)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query(
        "insert into team_members(team_id,user_id,role) values($1,$2,'owner'),($1,$3,'admin')",
    )
    .bind(team)
    .bind(f.owner)
    .bind(f.stranger)
    .execute(&f.db)
    .await
    .unwrap();
    let (_, token) = f.create_link(f.stranger).await;
    f.public(&token, StatusCode::OK).await;
    for role in ["member", "viewer"] {
        sqlx::query("update team_members set role=$1 where team_id=$2 and user_id=$3")
            .bind(role)
            .bind(team)
            .bind(f.stranger)
            .execute(&f.db)
            .await
            .unwrap();
        assert_eq!(
            f.create(f.stranger, "notes", None).await.status(),
            StatusCode::NOT_FOUND
        );
        f.public(&token, StatusCode::NOT_FOUND).await;
    }
    sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
        .bind(team)
        .bind(f.stranger)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.create(f.stranger, "notes", None).await.status(),
        StatusCode::NOT_FOUND
    );
    f.public(&token, StatusCode::NOT_FOUND).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn bounds_pagination_and_viewer_binding(db: PgPool) {
    let f = Fixture::new(db).await;
    for days in [0, 91] {
        assert_eq!(
            f.create(f.owner, "notes", Some(days)).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    for days in [1, 90] {
        assert_eq!(
            f.create(f.owner, "notes", Some(days)).await.status(),
            StatusCode::OK
        );
    }
    let durations: Vec<i32> = sqlx::query_scalar(
        "select extract(day from expires_at-created_at)::int from shares order by expires_at",
    )
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert_eq!(durations, vec![1, 90]);
    for limit in [0, 101] {
        assert_eq!(
            f.request(
                Method::GET,
                &format!("/shares?limit={limit}"),
                Some(f.owner),
                None
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let first = json_body(
        f.request(Method::GET, "/shares?limit=1", Some(f.owner), None)
            .await,
    )
    .await;
    assert_eq!(first["data"].as_array().unwrap().len(), 1);
    let cursor = first["meta"]["nextCursor"].as_str().unwrap();
    assert_eq!(
        f.request(
            Method::GET,
            &format!("/shares?limit=1&cursor={cursor}"),
            Some(f.stranger),
            None
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let second = json_body(
        f.request(
            Method::GET,
            &format!("/shares?limit=1&cursor={cursor}"),
            Some(f.owner),
            None,
        )
        .await,
    )
    .await;
    assert_ne!(first["data"][0]["id"], second["data"][0]["id"]);
    assert!(second["meta"]["nextCursor"].is_null());
    assert!(
        json_body(
            f.request(Method::GET, "/shares", Some(f.stranger), None)
                .await
        )
        .await["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn rate_limits_and_audit_failure_roll_back(db: PgPool) {
    let f = Fixture::new(db).await;
    // Make the audit insert fail without changing the production schema.
    sqlx::query("create function reject_share_audit() returns trigger language plpgsql as $$ begin raise exception 'test'; end $$").execute(&f.db).await.unwrap();
    sqlx::query("create trigger reject_share_audit before insert on audit_log for each row execute function reject_share_audit()").execute(&f.db).await.unwrap();
    assert_eq!(
        f.create(f.owner, "notes", None).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let count: i64 = sqlx::query_scalar("select count(*) from shares")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("drop trigger reject_share_audit on audit_log")
        .execute(&f.db)
        .await
        .unwrap();
    let (id, token) = f.create_link(f.owner).await;
    sqlx::query("create trigger reject_share_audit before insert on audit_log for each row execute function reject_share_audit()").execute(&f.db).await.unwrap();
    assert_eq!(
        f.request(
            Method::DELETE,
            &format!("/shares/{id}"),
            Some(f.owner),
            None
        )
        .await
        .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    f.public(&token, StatusCode::OK).await;
    for (key, budget) in [
        (
            "shares:public:ip:unknown".to_string(),
            limits::API_READ_PER_SUBJECT,
        ),
        (
            format!("shares:write:user:{}", f.stranger),
            limits::API_WRITE_PER_SUBJECT,
        ),
    ] {
        for _ in 0..budget.limit {
            security::rate_limit_hit(&f.db, &key, budget).await.unwrap();
        }
    }
    f.public(&token, StatusCode::TOO_MANY_REQUESTS).await;
    assert_eq!(
        f.create(f.stranger, "notes", None).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    for _ in 0..limits::API_WRITE_PER_SUBJECT.limit {
        security::rate_limit_hit(
            &f.db,
            "shares:write:ip:unknown",
            limits::API_WRITE_PER_SUBJECT,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        f.create(f.owner, "notes", None).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}
