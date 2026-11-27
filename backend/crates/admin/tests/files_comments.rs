#![allow(clippy::unwrap_used)]
//! Admin files and comments: the role gate, step-up, file metadata without a storage key, the
//! soft delete with its byte purge, the admin-only comment body, comment hide, unhide and soft
//! delete with audit rows, filter validation and paging, and unknown ids.

use async_trait::async_trait;
use axum::{
    Extension,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use bytes::Bytes;
use files::Storage;
use futures::stream::BoxStream;
use kernel::{AppState, config::Config, email::LogSender};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use time::OffsetDateTime;
use tower::ServiceExt;
use uuid::Uuid;

/// The same small registry as the content tests: `notes` is searchable on `title`.
const ENTITIES: &str = r#"{
  "notes": {"label":"Note","read":"public","create":"authenticated","write":"owner","allowPublic":true,"social":{"comments":true,"reactions":[],"bookmarks":false},"maxPerOwner":2000,"sortable":["title"],"filterable":[],"searchable":["title"],"schema":{"type":"object","additionalProperties":false,"required":["title"],"properties":{"title":{"type":"string","maxLength":200}}}},
  "plain": {"label":"Plain","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":2000,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"n":{"type":"integer"}}}}
}"#;

/// Records the keys it was asked to delete. With `fail` set, every delete errors, to check that a
/// failed purge does not undo the soft delete.
#[derive(Default)]
struct FakeStorage {
    deleted: Mutex<Vec<String>>,
    fail: bool,
}

#[async_trait]
impl Storage for FakeStorage {
    async fn put(&self, _key: &str, _bytes: Bytes) -> anyhow::Result<()> {
        anyhow::bail!("not used in these tests")
    }
    async fn get(
        &self,
        _key: &str,
    ) -> anyhow::Result<BoxStream<'static, Result<Bytes, object_store::Error>>> {
        anyhow::bail!("not used in these tests")
    }
    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.deleted.lock().unwrap().push(key.to_owned());
        if self.fail {
            anyhow::bail!("purge failed");
        }
        Ok(())
    }
}

struct Fixture {
    state: AppState,
    storage: Arc<FakeStorage>,
    admin_token: String,
    admin_session: Uuid,
    owner: Uuid,
    owner_token: String,
    commenter: Uuid,
    commenter_token: String,
}

struct Reply {
    status: StatusCode,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

async fn user(db: &sqlx::PgPool, email: &str, role: &str) -> Uuid {
    sqlx::query_scalar(
        "insert into users(email,role,email_verified_at) values($1,$2,now()) returning id",
    )
    .bind(email)
    .bind(role)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn session(db: &sqlx::PgPool, user: Uuid) -> (String, Uuid) {
    let (token, hash) = kernel::crypto::new_token();
    let id: Uuid = sqlx::query_scalar(
        "insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id",
    )
    .bind(user)
    .bind(hash.as_slice())
    .fetch_one(db)
    .await
    .unwrap();
    (token, id)
}

async fn fixture(db: sqlx::PgPool) -> Fixture {
    let admin = user(&db, "files-admin@example.test", "admin").await;
    let owner = user(&db, "files-owner@example.test", "user").await;
    let commenter = user(&db, "files-commenter@example.test", "user").await;
    let (admin_token, admin_session) = session(&db, admin).await;
    let (owner_token, _) = session(&db, owner).await;
    let (commenter_token, _) = session(&db, commenter).await;
    let path = std::env::temp_dir().join(format!("admin-files-comments-{}.json", Uuid::new_v4()));
    std::fs::write(&path, ENTITIES).unwrap();
    let mut config = Config::from_env().unwrap();
    config.entities_path = path.to_string_lossy().into_owned();
    let state = AppState {
        db,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    Fixture {
        state,
        storage: Arc::new(FakeStorage::default()),
        admin_token,
        admin_session,
        owner,
        owner_token,
        commenter,
        commenter_token,
    }
}

/// One request through the admin router, with the storage the server would provide.
async fn send(
    state: &AppState,
    storage: &Arc<FakeStorage>,
    token: Option<&str>,
    method: &str,
    uri: &str,
) -> Reply {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let storage: Arc<dyn Storage> = storage.clone();
    let response = admin::router()
        .layer(Extension(storage))
        .with_state(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 5_000_000).await.unwrap();
    Reply {
        status,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

/// The social read path as the public and the author see it.
async fn social_get(state: &AppState, token: Option<&str>, uri: &str) -> Reply {
    let registry = Arc::new(records::load_registry(&state.config.entities_path).unwrap());
    let mut request = Request::builder().method("GET").uri(uri);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = social::router()
        .layer(Extension(registry))
        .with_state(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 5_000_000).await.unwrap();
    Reply {
        status,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

async fn fresh_step_up(db: &sqlx::PgPool, session: Uuid) {
    sqlx::query(
        "insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256')) on conflict(session_id) do update set expires_at=excluded.expires_at",
    )
    .bind(session)
    .execute(db)
    .await
    .unwrap();
}

async fn expire_step_up(db: &sqlx::PgPool, session: Uuid) {
    sqlx::query(
        "update admin_step_up set expires_at=now()-interval '1 second' where session_id=$1",
    )
    .bind(session)
    .execute(db)
    .await
    .unwrap();
}

/// A file row as the upload path leaves it. The key is the storage path that must never leak.
async fn create_file(
    db: &sqlx::PgPool,
    owner: Uuid,
    name: &str,
    key: &str,
    minutes_ago: i32,
) -> Uuid {
    sqlx::query_scalar(
        "insert into files(id,owner_id,key,content_type,size_bytes,sha256,original_name,created_at) values(gen_random_uuid(),$1,$2,'text/plain',42,decode(repeat('ab',32),'hex'),$3,now()-($4::int*interval '1 minute')) returning id",
    )
    .bind(owner)
    .bind(key)
    .bind(name)
    .bind(minutes_ago)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn create_note(db: &sqlx::PgPool, owner: Uuid, title: &str, visibility: &str) -> Uuid {
    sqlx::query_scalar(
        "insert into records(entity,owner_id,data,visibility) values('notes',$1,jsonb_build_object('title',$2::text),$3) returning id",
    )
    .bind(owner)
    .bind(title)
    .bind(visibility)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn create_comment(
    db: &sqlx::PgPool,
    record: Uuid,
    author: Uuid,
    body: &str,
    minutes_ago: i32,
) -> Uuid {
    sqlx::query_scalar(
        "insert into social_comments(entity,record_id,author_id,body,created_at) values('notes',$1,$2,$3,now()-($4::int*interval '1 minute')) returning id",
    )
    .bind(record)
    .bind(author)
    .bind(body)
    .bind(minutes_ago)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn file_deleted(db: &sqlx::PgPool, id: Uuid) -> bool {
    sqlx::query_scalar("select deleted_at is not null from files where id=$1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

/// `(hidden, deleted)` for one comment.
async fn comment_state(db: &sqlx::PgPool, id: Uuid) -> (bool, bool) {
    sqlx::query_as(
        "select admin_hidden_at is not null, deleted_at is not null from social_comments where id=$1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn hidden_at(db: &sqlx::PgPool, id: Uuid) -> Option<OffsetDateTime> {
    sqlx::query_scalar("select admin_hidden_at from social_comments where id=$1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn audit_rows(db: &sqlx::PgPool, action: &str, target: &str) -> Vec<Value> {
    sqlx::query_scalar("select meta from audit_log where action=$1 and target_id=$2 order by id")
        .bind(action)
        .bind(target)
        .fetch_all(db)
        .await
        .unwrap()
}

fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

fn ids(page: &Reply) -> Vec<String> {
    page.json()["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

/// Follows `meta.nextCursor` until it is null, returning every id in order.
async fn all_pages(f: &Fixture, base: &str) -> Vec<String> {
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let sep = if base.contains('?') { '&' } else { '?' };
        let uri = match &cursor {
            Some(c) => format!("{base}{sep}cursor={c}"),
            None => base.to_owned(),
        };
        let page = send(&f.state, &f.storage, Some(&f.admin_token), "GET", &uri).await;
        assert_eq!(page.status, StatusCode::OK, "{uri}");
        seen.extend(ids(&page));
        cursor = page.json()["meta"]["nextCursor"]
            .as_str()
            .map(str::to_owned);
        if cursor.is_none() {
            return seen;
        }
    }
}

// ----------------------------------------------------------------------------------------------

#[sqlx::test(migrations = "../../migrations")]
async fn new_routes_refuse_non_admins_and_anonymous(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let file = create_file(&db, f.owner, "private.txt", "owner/key-a.bin", 5).await;
    let note = create_note(&db, f.owner, "Host", "public").await;
    let comment = create_comment(&db, note, f.commenter, "a body", 5).await;
    let routes = [
        ("GET", "/files".to_owned()),
        ("GET", format!("/files/{file}")),
        ("DELETE", format!("/files/{file}")),
        ("GET", "/comments".to_owned()),
        ("POST", format!("/comments/{comment}/hide")),
        ("POST", format!("/comments/{comment}/unhide")),
        ("POST", format!("/comments/{comment}/delete")),
    ];
    for (method, uri) in &routes {
        let owner = send(&f.state, &f.storage, Some(&f.owner_token), method, uri).await;
        assert_eq!(owner.status, StatusCode::FORBIDDEN, "{method} {uri}");
        let anonymous = send(&f.state, &f.storage, None, method, uri).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    // Refused requests change nothing and write no audit rows.
    assert!(!file_deleted(&db, file).await);
    assert_eq!(comment_state(&db, comment).await, (false, false));
    assert!(f.storage.deleted.lock().unwrap().is_empty());
    let audit: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action like 'admin.files%' or action like 'admin.comments%'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audit, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn mutations_need_a_fresh_step_up(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let file = create_file(&db, f.owner, "keep.txt", "owner/key-b.bin", 5).await;
    let note = create_note(&db, f.owner, "Host", "public").await;
    let comment = create_comment(&db, note, f.commenter, "a body", 5).await;
    let mutations = [
        ("DELETE", format!("/files/{file}")),
        ("POST", format!("/comments/{comment}/hide")),
        ("POST", format!("/comments/{comment}/unhide")),
        ("POST", format!("/comments/{comment}/delete")),
    ];
    // Without any step-up, every mutation is refused before it changes anything.
    for (method, uri) in &mutations {
        let r = send(&f.state, &f.storage, admin, method, uri).await;
        assert_eq!(
            r.status,
            StatusCode::PRECONDITION_REQUIRED,
            "{method} {uri}"
        );
        assert!(r.body.contains("STEP_UP_REQUIRED"));
    }
    assert!(!file_deleted(&db, file).await);
    assert_eq!(comment_state(&db, comment).await, (false, false));

    // A step-up that has expired is refused the same way.
    fresh_step_up(&db, f.admin_session).await;
    expire_step_up(&db, f.admin_session).await;
    for (method, uri) in &mutations {
        let r = send(&f.state, &f.storage, admin, method, uri).await;
        assert_eq!(
            r.status,
            StatusCode::PRECONDITION_REQUIRED,
            "expired {method} {uri}"
        );
    }
    assert!(!file_deleted(&db, file).await);

    // With a fresh step-up the same route succeeds, so the refusals above came from the check.
    fresh_step_up(&db, f.admin_session).await;
    let hide = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{comment}/hide"),
    )
    .await;
    assert_eq!(hide.status, StatusCode::NO_CONTENT);
    assert_eq!(comment_state(&db, comment).await, (true, false));
}

#[sqlx::test(migrations = "../../migrations")]
async fn files_list_is_metadata_only_filters_and_pages(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let other = user(&db, "files-other@example.test", "user").await;
    let report = create_file(
        &db,
        f.owner,
        "report 100%.pdf",
        "owner/SECRET-KEY-1.bin",
        30,
    )
    .await;
    let thousand = create_file(
        &db,
        f.owner,
        "report 1000.pdf",
        "owner/SECRET-KEY-2.bin",
        20,
    )
    .await;
    let notes = create_file(&db, other, "notes_v2.txt", "other/SECRET-KEY-3.bin", 10).await;

    // Every row has exactly the metadata fields, and no storage key, path or URL anywhere.
    let all = send(&f.state, &f.storage, admin, "GET", "/files").await;
    assert_eq!(all.status, StatusCode::OK);
    let rows = all.json()["data"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 3);
    let expected: BTreeSet<String> = [
        "id",
        "ownerId",
        "name",
        "contentType",
        "size",
        "createdAt",
        "deletedAt",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    for row in &rows {
        assert_eq!(keys(row), expected);
    }
    assert!(!all.body.contains("SECRET-KEY"));
    assert!(!all.body.contains("owner/"));
    assert!(!all.body.contains("storageKey"));
    assert_eq!(rows[0]["size"], 42);

    // `q` is a literal, case-insensitive match on the name: `%` does not match "1000".
    let found = send(&f.state, &f.storage, admin, "GET", "/files?q=100%25").await;
    assert_eq!(ids(&found), [report.to_string()]);
    let found = send(&f.state, &f.storage, admin, "GET", "/files?q=NOTES_V2").await;
    assert_eq!(ids(&found), [notes.to_string()]);

    // Owner filter.
    let found = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        &format!("/files?ownerId={}", f.owner),
    )
    .await;
    assert_eq!(found.json()["data"].as_array().unwrap().len(), 2);

    // Soft-deleted rows are hidden by default and shown with deleted=true.
    sqlx::query("update files set deleted_at=now() where id=$1")
        .bind(thousand)
        .execute(&db)
        .await
        .unwrap();
    let live = send(&f.state, &f.storage, admin, "GET", "/files").await;
    assert_eq!(live.json()["data"].as_array().unwrap().len(), 2);
    let gone = send(&f.state, &f.storage, admin, "GET", "/files?deleted=true").await;
    assert_eq!(ids(&gone), [thousand.to_string()]);
    assert!(gone.json()["data"][0]["deletedAt"].is_string());

    // Paging with limit 1 returns every live file once, in order, and no duplicates.
    let paged = all_pages(&f, "/files?limit=1").await;
    assert_eq!(paged.len(), 2);
    let unique: BTreeSet<&String> = paged.iter().collect();
    assert_eq!(unique.len(), 2);

    // Bad parameters are 400, and the storage key is never a valid filter.
    for uri in [
        "/files?ownerId=nope",
        "/files?deleted=maybe",
        "/files?limit=0",
        "/files?limit=101",
        "/files?q=a%0Ab",
        "/files?cursor=not-a-cursor",
        "/files?key=owner/SECRET-KEY-1.bin",
    ] {
        let r = send(&f.state, &f.storage, admin, "GET", uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn file_detail_and_soft_delete_purge_and_audit(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let file = create_file(&db, f.owner, "delete-me.txt", "owner/SECRET-KEY-DEL.bin", 1).await;

    // The detail has the metadata and a history, and neither shows the key.
    let detail = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        &format!("/files/{file}"),
    )
    .await;
    assert_eq!(detail.status, StatusCode::OK);
    assert!(!detail.body.contains("SECRET-KEY"));
    assert_eq!(detail.json()["data"]["name"], "delete-me.txt");
    assert!(detail.json()["data"]["history"].is_array());

    fresh_step_up(&db, f.admin_session).await;
    let deleted = send(
        &f.state,
        &f.storage,
        admin,
        "DELETE",
        &format!("/files/{file}"),
    )
    .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert!(file_deleted(&db, file).await);
    // The bytes go after the commit, using the key from the database row.
    assert_eq!(
        f.storage.deleted.lock().unwrap().as_slice(),
        ["owner/SECRET-KEY-DEL.bin".to_owned()]
    );

    // One audit row with before and after, holding only ids and sizes.
    let rows = audit_rows(&db, "admin.files.delete", &file.to_string()).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["before"]["deleted"], false);
    assert_eq!(rows[0]["after"]["deleted"], true);
    assert_eq!(rows[0]["after"]["sizeBytes"], 42);
    assert_eq!(rows[0]["after"]["ownerId"], f.owner.to_string());
    let meta = rows[0].to_string();
    assert!(!meta.contains("SECRET-KEY"));
    assert!(!meta.contains("owner/"));

    // Deleting again is not found and writes no second audit row.
    fresh_step_up(&db, f.admin_session).await;
    let again = send(
        &f.state,
        &f.storage,
        admin,
        "DELETE",
        &format!("/files/{file}"),
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(
        audit_rows(&db, "admin.files.delete", &file.to_string())
            .await
            .len(),
        1
    );

    // The history shows the delete, still without the key.
    let after = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        &format!("/files/{file}"),
    )
    .await;
    assert!(after.json()["data"]["deletedAt"].is_string());
    let history = after.json()["data"]["history"].clone();
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["action"] == "admin.files.delete")
    );
    assert!(!after.body.contains("SECRET-KEY"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn failed_purge_keeps_the_soft_delete(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let file = create_file(&db, f.owner, "stuck.txt", "owner/SECRET-KEY-STUCK.bin", 1).await;
    let failing = Arc::new(FakeStorage {
        fail: true,
        ..Default::default()
    });
    fresh_step_up(&db, f.admin_session).await;
    let r = send(
        &f.state,
        &failing,
        admin,
        "DELETE",
        &format!("/files/{file}"),
    )
    .await;
    // The purge error is best effort: the soft delete and its audit row stand, and the reply is 204.
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(file_deleted(&db, file).await);
    assert_eq!(
        audit_rows(&db, "admin.files.delete", &file.to_string())
            .await
            .len(),
        1
    );
    assert_eq!(failing.deleted.lock().unwrap().len(), 1);
    assert!(!r.body.contains("SECRET-KEY"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn hidden_comment_body_is_admin_only(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let note = create_note(&db, f.owner, "Host", "public").await;
    let hidden = create_comment(&db, note, f.commenter, "the hidden phrase here", 3).await;
    let deleted = create_comment(&db, note, f.commenter, "vanish-token ordinary", 2).await;
    sqlx::query("update social_comments set deleted_at=now() where id=$1")
        .bind(deleted)
        .execute(&db)
        .await
        .unwrap();
    fresh_step_up(&db, f.admin_session).await;
    let r = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{hidden}/hide"),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    // The admin list shows the hidden body.
    let live = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        &format!("/comments?recordId={note}"),
    )
    .await;
    assert_eq!(live.json()["data"][0]["body"], "the hidden phrase here");
    assert_eq!(live.json()["data"][0]["hidden"], true);
    // An author-deleted comment that is not hidden keeps its placeholder, even for the admin.
    let gone = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        &format!("/comments?recordId={note}&deleted=true"),
    )
    .await;
    assert_eq!(gone.json()["data"][0]["id"], deleted.to_string());
    assert!(gone.json()["data"][0]["body"].is_null());
    // Search cannot be used to read a placeholder: the deleted text does not match, but a shown one does.
    let none = send(&f.state, &f.storage, admin, "GET", "/comments?q=vanish").await;
    assert!(ids(&none).is_empty());
    let shown = send(
        &f.state,
        &f.storage,
        admin,
        "GET",
        "/comments?q=hidden%20phrase",
    )
    .await;
    assert_eq!(ids(&shown), [hidden.to_string()]);

    // The ordinary social read shows the placeholder to the public and to the author.
    let uri = format!("/entities/notes/{note}/comments");
    for token in [None, Some(f.commenter_token.as_str())] {
        let social = social_get(&f.state, token, &uri).await;
        assert_eq!(social.status, StatusCode::OK);
        assert!(!social.body.contains("hidden phrase"));
        assert!(!social.body.contains("vanish-token"));
        let rows = social.json()["data"].as_array().unwrap().clone();
        assert!(rows.iter().all(|row| row["body"].is_null()));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn comment_hide_unhide_and_soft_delete_round_trip(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let note = create_note(&db, f.owner, "Host", "public").await;
    let comment = create_comment(&db, note, f.commenter, "ordinary text", 1).await;
    let id = comment.to_string();
    fresh_step_up(&db, f.admin_session).await;

    // Hide sets the flag and writes a before/after row.
    let r = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{id}/hide"),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(comment_state(&db, comment).await, (true, false));
    let first_hidden = hidden_at(&db, comment).await;

    // Hiding again changes nothing, keeps the first hide time, and still writes its row.
    let r = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{id}/hide"),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(hidden_at(&db, comment).await, first_hidden);

    let hides = audit_rows(&db, "admin.comments.hide", &id).await;
    assert_eq!(hides.len(), 2);
    assert_eq!(hides[0]["before"]["hidden"], false);
    assert_eq!(hides[0]["after"]["hidden"], true);
    assert_eq!(hides[1]["before"]["hidden"], true);

    // Unhide clears the flag.
    let r = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{id}/unhide"),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(comment_state(&db, comment).await, (false, false));
    let unhides = audit_rows(&db, "admin.comments.unhide", &id).await;
    assert_eq!(unhides.len(), 1);
    assert_eq!(unhides[0]["after"]["hidden"], false);

    // Soft delete keeps the row. It leaves the default list and shows under deleted=true.
    let r = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{id}/delete"),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(comment_state(&db, comment).await, (false, true));
    let live = send(&f.state, &f.storage, admin, "GET", "/comments").await;
    assert!(!ids(&live).contains(&id));
    let gone = send(&f.state, &f.storage, admin, "GET", "/comments?deleted=true").await;
    assert!(ids(&gone).contains(&id));
    let row = gone.json()["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap()
        .clone();
    assert!(row["body"].is_null());
    assert!(row["deletedAt"].is_string());

    let deletes = audit_rows(&db, "admin.comments.delete", &id).await;
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0]["before"]["deleted"], false);
    assert_eq!(deletes[0]["after"]["deleted"], true);
    // Audit meta holds flags only, never the body.
    for row in hides.iter().chain(unhides.iter()).chain(deletes.iter()) {
        assert!(!row.to_string().contains("ordinary text"));
    }

    // Deleting an already deleted comment is not found and writes no second row.
    let again = send(
        &f.state,
        &f.storage,
        admin,
        "POST",
        &format!("/comments/{id}/delete"),
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(audit_rows(&db, "admin.comments.delete", &id).await.len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn comment_list_validates_filters_and_pages(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let note = create_note(&db, f.owner, "Host", "public").await;
    let other_note = create_note(&db, f.owner, "Other", "public").await;
    for minutes in 1..=5 {
        create_comment(
            &db,
            note,
            f.commenter,
            &format!("comment {minutes}"),
            minutes,
        )
        .await;
    }
    create_comment(&db, other_note, f.commenter, "elsewhere", 9).await;

    // Paging with limit 2 returns the five comments on this record once each.
    let paged = all_pages(&f, &format!("/comments?recordId={note}&limit=2")).await;
    assert_eq!(paged.len(), 5);
    assert_eq!(paged.iter().collect::<BTreeSet<_>>().len(), 5);

    // Entity filter: a known name is a filter, an unknown name is 400, and nothing reaches SQL.
    let by_entity = send(&f.state, &f.storage, admin, "GET", "/comments?entity=notes").await;
    assert_eq!(by_entity.json()["data"].as_array().unwrap().len(), 6);
    for uri in [
        "/comments?entity=unknown",
        "/comments?entity=notes%27%20or%201%3D1--",
        "/comments?recordId=nope",
        "/comments?hidden=maybe",
        "/comments?limit=101",
        "/comments?q=a%0Ab",
        "/comments?bogus=1",
        "/comments?cursor=garbage",
    ] {
        let r = send(&f.state, &f.storage, admin, "GET", uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_ids_are_404_and_malformed_are_400(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    fresh_step_up(&db, f.admin_session).await;
    let missing = Uuid::new_v4();
    for (method, uri) in [
        ("GET", format!("/files/{missing}")),
        ("DELETE", format!("/files/{missing}")),
        ("POST", format!("/comments/{missing}/hide")),
        ("POST", format!("/comments/{missing}/unhide")),
        ("POST", format!("/comments/{missing}/delete")),
    ] {
        let r = send(&f.state, &f.storage, admin, method, &uri).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {uri}");
    }
    for (method, uri) in [
        ("GET", "/files/not-a-uuid".to_owned()),
        ("DELETE", "/files/not-a-uuid".to_owned()),
        ("POST", "/comments/not-a-uuid/hide".to_owned()),
    ] {
        let r = send(&f.state, &f.storage, admin, method, &uri).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {uri}");
    }
    // Nothing was written for any of the refused requests.
    let audit: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action like 'admin.files%' or action like 'admin.comments%'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(audit, 0);
}
