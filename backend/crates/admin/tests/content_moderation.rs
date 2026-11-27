#![allow(clippy::unwrap_used)]
//! Content moderation: role gate, step-up, hide/unhide, delete/restore, team rows, list and detail
//! validation, paging, and redaction.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{AppState, ErrorCode, config::Config, email::LogSender};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

/// A small registry written to a temp file, so the tests control the entities they use.
/// `notes` is searchable on `title`. `plain` has no searchable fields.
const ENTITIES: &str = r#"{
  "notes": {"label":"Note","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":2000,"sortable":["title"],"filterable":[],"searchable":["title"],"schema":{"type":"object","additionalProperties":false,"required":["title"],"properties":{"title":{"type":"string","maxLength":200}}}},
  "plain": {"label":"Plain","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":2000,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"n":{"type":"integer"}}}}
}"#;

struct Fixture {
    state: AppState,
    admin_token: String,
    admin_session: Uuid,
    owner: Uuid,
    owner_token: String,
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
    let admin: Uuid = sqlx::query_scalar(
        "insert into users(email,role,email_verified_at) values('mod-admin@example.test','admin',now()) returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let owner: Uuid = sqlx::query_scalar(
        "insert into users(email,password_hash,email_verified_at) values('owner-private@example.test','sensitive-hash',now()) returning id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let (admin_token, admin_session) = session(&db, admin).await;
    let (owner_token, _) = session(&db, owner).await;
    let path = std::env::temp_dir().join(format!("admin-content-{}.json", Uuid::new_v4()));
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
        admin_token,
        admin_session,
        owner,
        owner_token,
    }
}

async fn call(state: &AppState, token: Option<&str>, method: &str, uri: &str) -> Reply {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = admin::router()
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

/// The records API as a caller would see it. Used to check what the owner and the public see.
async fn records_get(state: &AppState, token: Option<&str>, entity: &str, id: Uuid) -> Reply {
    let mut request = Request::builder()
        .method("GET")
        .uri(format!("/entities/{entity}/{id}"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let registry = records::load_registry(&state.config.entities_path).unwrap();
    let response = records::router(Arc::new(registry))
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

/// A fresh step-up flag for the admin session, as the step-up route would issue it. The admin has
/// no password, so the snapshot is the hash of the empty string.
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

async fn version_and_flags(db: &sqlx::PgPool, id: Uuid) -> (i32, bool, bool) {
    let (version, hidden, deleted): (i32, bool, bool) = sqlx::query_as(
        "select version,admin_hidden_at is not null,deleted_at is not null from records where id=$1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .unwrap();
    (version, hidden, deleted)
}

fn error_code(reply: &Reply) -> String {
    reply.json()["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn ids(page: &Reply) -> Vec<String> {
    page.json()["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test(migrations = "../../migrations")]
async fn content_routes_refuse_non_admins_and_anonymous(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let id = create_note(&db, f.owner, "Hello", "public").await;
    for (method, uri) in [
        ("GET", "/content?entity=notes".to_string()),
        ("GET", format!("/content/notes/{id}")),
        ("POST", format!("/content/notes/{id}/hide")),
        ("POST", format!("/content/notes/{id}/unhide")),
        ("POST", format!("/content/notes/{id}/delete")),
        ("POST", format!("/content/notes/{id}/restore")),
    ] {
        let as_user = call(&f.state, Some(&f.owner_token), method, &uri).await;
        assert_eq!(as_user.status, StatusCode::FORBIDDEN, "{method} {uri}");
        let anonymous = call(&f.state, None, method, &uri).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    // Nothing changed.
    assert_eq!(version_and_flags(&db, id).await, (1, false, false));
}

#[sqlx::test(migrations = "../../migrations")]
async fn mutations_need_a_fresh_step_up(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let id = create_note(&db, f.owner, "Needs approval", "public").await;
    let hide = format!("/content/notes/{id}/hide");

    let missing = call(&f.state, Some(&f.admin_token), "POST", &hide).await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
    assert!(missing.body.contains("STEP_UP_REQUIRED"));
    assert_eq!(version_and_flags(&db, id).await, (1, false, false));

    fresh_step_up(&db, f.admin_session).await;
    assert_eq!(
        call(&f.state, Some(&f.admin_token), "POST", &hide)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(version_and_flags(&db, id).await, (2, true, false));

    // An expired step-up is refused, and the refused call changes nothing.
    expire_step_up(&db, f.admin_session).await;
    let expired = call(
        &f.state,
        Some(&f.admin_token),
        "POST",
        &format!("/content/notes/{id}/unhide"),
    )
    .await;
    assert_eq!(expired.status, StatusCode::PRECONDITION_REQUIRED);
    assert!(expired.body.contains("STEP_UP_REQUIRED"));
    assert_eq!(version_and_flags(&db, id).await, (2, true, false));
}

#[sqlx::test(migrations = "../../migrations")]
async fn hide_then_unhide_toggles_flag_and_keeps_owner_access(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    fresh_step_up(&db, f.admin_session).await;
    let id = create_note(&db, f.owner, "Secret plan", "public").await;
    let state = &f.state;
    let admin = Some(f.admin_token.as_str());

    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/hide"))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let detail = call(state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.status, StatusCode::OK);
    assert_eq!(detail.json()["data"]["moderationHidden"], true);
    assert_eq!(detail.json()["data"]["version"], 2);
    let hidden_list = call(state, admin, "GET", "/content?entity=notes&hidden=true").await;
    assert!(ids(&hidden_list).contains(&id.to_string()));

    // The owner keeps reading their own hidden record. Everyone else gets 404.
    let owner = records_get(state, Some(&f.owner_token), "notes", id).await;
    assert_eq!(owner.status, StatusCode::OK);
    assert_eq!(
        records_get(state, None, "notes", id).await.status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/unhide"))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let detail = call(state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.json()["data"]["moderationHidden"], false);
    assert_eq!(detail.json()["data"]["version"], 3);
    assert_eq!(
        records_get(state, None, "notes", id).await.status,
        StatusCode::OK
    );

    // Audit rows hold ids, state and the action, never the record's content.
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "select action,meta from audit_log where target_type='record' and target_id=$1 order by id",
    )
    .bind(id.to_string())
    .fetch_all(&db)
    .await
    .unwrap();
    let actions: Vec<&str> = rows.iter().map(|(action, _)| action.as_str()).collect();
    assert_eq!(actions, ["admin.content.hide", "admin.content.unhide"]);
    assert_eq!(rows[0].1["before"]["version"], 1);
    assert_eq!(rows[0].1["after"]["version"], 2);
    assert_eq!(rows[0].1["after"]["moderationHidden"], true);
    assert_eq!(rows[1].1["after"]["moderationHidden"], false);
    assert!(!rows[0].1.to_string().contains("Secret plan"));
    assert!(!rows[1].1.to_string().contains("Secret plan"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn soft_delete_then_restore_keeps_versions_increasing(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    fresh_step_up(&db, f.admin_session).await;
    let id = create_note(&db, f.owner, "Come back later", "public").await;
    let state = &f.state;
    let admin = Some(f.admin_token.as_str());
    let mut versions = vec![version_and_flags(&db, id).await.0];

    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/delete"))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    versions.push(version_and_flags(&db, id).await.0);
    let detail = call(state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.json()["data"]["deleted"], true);
    // The owner no longer reads it, and it drops out of the default (live) list.
    assert_eq!(
        records_get(state, Some(&f.owner_token), "notes", id)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let live = call(state, admin, "GET", "/content?entity=notes").await;
    assert!(!ids(&live).contains(&id.to_string()));
    let deleted = call(state, admin, "GET", "/content?entity=notes&deleted=true").await;
    assert!(ids(&deleted).contains(&id.to_string()));
    // Deleting again is not a live record, so it is 404.
    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/delete"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        call(
            state,
            admin,
            "POST",
            &format!("/content/notes/{id}/restore")
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    versions.push(version_and_flags(&db, id).await.0);
    let detail = call(state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.json()["data"]["deleted"], false);
    assert_eq!(
        records_get(state, Some(&f.owner_token), "notes", id)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        call(
            state,
            admin,
            "POST",
            &format!("/content/notes/{id}/restore")
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(versions, [1, 2, 3]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_rows_are_moderated_only_through_the_admin_path(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    fresh_step_up(&db, f.admin_session).await;
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Crew','crew-moderation',$1) returning id",
    )
    .bind(f.owner)
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'owner')")
        .bind(team)
        .bind(f.owner)
        .execute(&db)
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data,visibility,team_id) values('notes',$1,jsonb_build_object('title','Team plan'),'private',$2) returning id",
    )
    .bind(f.owner)
    .bind(team)
    .fetch_one(&db)
    .await
    .unwrap();
    let state = &f.state;
    let admin = Some(f.admin_token.as_str());

    // The admin is not a team member, and the admin path still works.
    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/hide"))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let detail = call(state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.json()["data"]["moderationHidden"], true);
    assert_eq!(detail.json()["data"]["teamId"], team.to_string());
    let team_rows = call(state, admin, "GET", "/content?entity=notes&visibility=team").await;
    assert_eq!(ids(&team_rows), [id.to_string()]);
    let personal = call(
        state,
        admin,
        "GET",
        "/content?entity=notes&visibility=private",
    )
    .await;
    assert!(!ids(&personal).contains(&id.to_string()));

    // The public records path refuses the same record.
    let mut tx = db.begin().await.unwrap();
    let refused = records::moderation::set_personal_hidden(&mut tx, id, false)
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::ValidationFailed);
    tx.rollback().await.unwrap();

    assert_eq!(
        call(state, admin, "POST", &format!("/content/notes/{id}/unhide"))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(version_and_flags(&db, id).await, (3, false, false));
}

#[sqlx::test(migrations = "../../migrations")]
async fn list_validates_every_parameter_strictly(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let long = "x".repeat(201);
    let cases = [
        ("/content", StatusCode::BAD_REQUEST),
        ("/content?entity=", StatusCode::BAD_REQUEST),
        ("/content?entity=nope", StatusCode::NOT_FOUND),
        ("/content?entity=notes&limit=0", StatusCode::BAD_REQUEST),
        ("/content?entity=notes&limit=101", StatusCode::BAD_REQUEST),
        ("/content?entity=notes&limit=abc", StatusCode::BAD_REQUEST),
        (
            "/content?entity=notes&visibility=bogus",
            StatusCode::BAD_REQUEST,
        ),
        (
            "/content?entity=notes&deleted=maybe",
            StatusCode::BAD_REQUEST,
        ),
        ("/content?entity=notes&cursor=!!!", StatusCode::BAD_REQUEST),
        ("/content?entity=notes&unknown=1", StatusCode::BAD_REQUEST),
        ("/content?entity=notes&q=a%0Ab", StatusCode::BAD_REQUEST),
        ("/content?entity=plain&q=x", StatusCode::BAD_REQUEST),
    ];
    for (uri, expected) in cases {
        let reply = call(&f.state, admin, "GET", uri).await;
        assert_eq!(reply.status, expected, "{uri}");
        if expected == StatusCode::BAD_REQUEST {
            assert_eq!(error_code(&reply), "VALIDATION_FAILED", "{uri}");
        }
    }
    let too_long = call(
        &f.state,
        admin,
        "GET",
        &format!("/content?entity=notes&q={long}"),
    )
    .await;
    assert_eq!(too_long.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&too_long), "VALIDATION_FAILED");
}

#[sqlx::test(migrations = "../../migrations")]
async fn list_pages_without_duplicates_and_filters_work(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    // Five notes with distinct creation times, newest first in the list.
    let mut all = Vec::new();
    for i in 0..5 {
        let id: Uuid = sqlx::query_scalar(
            "insert into records(entity,owner_id,data,visibility,created_at) values('notes',$1,jsonb_build_object('title',$2::text),'public',now()-($3::int * interval '1 minute')) returning id",
        )
        .bind(f.owner)
        .bind(format!("Item {i}"))
        .bind(i)
        .fetch_one(&db)
        .await
        .unwrap();
        all.push(id.to_string());
    }
    let first = call(&f.state, admin, "GET", "/content?entity=notes&limit=2").await;
    assert_eq!(first.status, StatusCode::OK);
    let mut seen = ids(&first);
    let cursor = first.json()["meta"]["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = call(
        &f.state,
        admin,
        "GET",
        &format!("/content?entity=notes&limit=2&cursor={cursor}"),
    )
    .await;
    seen.extend(ids(&second));
    let cursor = second.json()["meta"]["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let third = call(
        &f.state,
        admin,
        "GET",
        &format!("/content?entity=notes&limit=2&cursor={cursor}"),
    )
    .await;
    seen.extend(ids(&third));
    assert!(third.json()["meta"]["nextCursor"].is_null());
    assert_eq!(seen, all, "every note once, newest first");

    // Search is a case-insensitive substring match over the searchable fields.
    sqlx::query("insert into records(entity,owner_id,data,visibility) values('notes',$1,jsonb_build_object('title','Needle in a haystack'),'private')")
        .bind(f.owner)
        .execute(&db)
        .await
        .unwrap();
    let found = call(&f.state, admin, "GET", "/content?entity=notes&q=NEEDLE").await;
    assert_eq!(found.json()["data"].as_array().unwrap().len(), 1);
    assert_eq!(found.json()["data"][0]["visibility"], "private");

    let public = call(
        &f.state,
        admin,
        "GET",
        "/content?entity=notes&visibility=public",
    )
    .await;
    assert_eq!(ids(&public).len(), 5);
}

#[sqlx::test(migrations = "../../migrations")]
async fn detail_is_bounded_sanitized_and_404s(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let id = create_note(&db, f.owner, "Detail", "public").await;
    let admin = Some(f.admin_token.as_str());

    let detail = call(&f.state, admin, "GET", &format!("/content/notes/{id}")).await;
    assert_eq!(detail.status, StatusCode::OK);
    assert_eq!(detail.json()["data"]["data"]["title"], "Detail");
    assert_eq!(detail.json()["data"]["history"], json!([]));

    // Sixty old audit rows, with a secret-looking key in the stored meta.
    sqlx::query(
        "insert into audit_log(action,target_type,target_id,meta) select 'admin.content.hide','record',$1,jsonb_build_object('before',jsonb_build_object('version',1,'passwordHash','leak-me')) from generate_series(1,60)",
    )
    .bind(id.to_string())
    .execute(&db)
    .await
    .unwrap();
    let detail = call(&f.state, admin, "GET", &format!("/content/notes/{id}")).await;
    let history = detail.json()["data"]["history"].as_array().unwrap().clone();
    assert_eq!(history.len(), 50);
    assert!(!detail.body.contains("leak-me"));
    assert!(!detail.body.contains("passwordHash"));

    assert_eq!(
        call(
            &f.state,
            admin,
            "GET",
            &format!("/content/notes/{}", Uuid::new_v4())
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&f.state, admin, "GET", &format!("/content/plain/{id}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&f.state, admin, "GET", "/content/nope/nope")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&f.state, admin, "GET", "/content/notes/not-a-uuid")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn responses_never_expose_secrets_or_other_users(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let id = create_note(&db, f.owner, "Public note", "public").await;
    let admin = Some(f.admin_token.as_str());
    let list = call(&f.state, admin, "GET", "/content?entity=notes").await;
    let detail = call(&f.state, admin, "GET", &format!("/content/notes/{id}")).await;
    for body in [&list.body, &detail.body] {
        assert!(!body.contains("sensitive-hash"), "password hash leaked");
        assert!(!body.contains("owner-private@example.test"), "email leaked");
        assert!(!body.contains("mod-admin@example.test"), "email leaked");
        assert!(!body.contains("token_hash"), "session data leaked");
    }
    // The owner's id is the only account detail a row carries.
    assert_eq!(list.json()["data"][0]["ownerId"], f.owner.to_string());
}

#[sqlx::test(migrations = "../../migrations")]
async fn content_search_is_literal_and_case_insensitive(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let admin = Some(f.admin_token.as_str());
    let percent = create_note(&db, f.owner, "Save 100% today", "public").await;
    let thousand = create_note(&db, f.owner, "Save 1000 today", "public").await;
    let underscore = create_note(&db, f.owner, "Snake_case name", "public").await;
    let plain = create_note(&db, f.owner, "Snakexcase name", "public").await;
    let slash = create_note(&db, f.owner, r"Back\slash", "public").await;
    let state = &f.state;

    // A `%` in the search is literal, so "100" does not match "1000".
    let found = call(state, admin, "GET", "/content?entity=notes&q=100%25").await;
    assert_eq!(ids(&found), [percent.to_string()]);
    // A bare `%` matches only the row that holds one, not every row.
    let found = call(state, admin, "GET", "/content?entity=notes&q=%25").await;
    assert_eq!(ids(&found), [percent.to_string()]);
    // `_` is literal too: "snake_case" does not match "Snakexcase".
    let found = call(state, admin, "GET", "/content?entity=notes&q=snake_case").await;
    assert_eq!(ids(&found), [underscore.to_string()]);
    assert!(!ids(&found).contains(&plain.to_string()));
    // A backslash in the search matches a backslash in the data.
    let found = call(state, admin, "GET", "/content?entity=notes&q=back%5Cslash").await;
    assert_eq!(ids(&found), [slash.to_string()]);
    // Matching ignores case.
    let found = call(state, admin, "GET", "/content?entity=notes&q=SAVE").await;
    assert_eq!(found.json()["data"].as_array().unwrap().len(), 2);
    assert!(ids(&found).contains(&thousand.to_string()));
    // No match is an empty page, not an error.
    let found = call(state, admin, "GET", "/content?entity=notes&q=zzz-nothing").await;
    assert_eq!(found.status, StatusCode::OK);
    assert!(ids(&found).is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn team_visibility_filter_combines_with_search(db: sqlx::PgPool) {
    let f = fixture(db.clone()).await;
    let team: Uuid = sqlx::query_scalar(
        "insert into teams(name,slug,created_by) values('Crew','crew-search',$1) returning id",
    )
    .bind(f.owner)
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'owner')")
        .bind(team)
        .bind(f.owner)
        .execute(&db)
        .await
        .unwrap();
    let team_row: Uuid = sqlx::query_scalar(
        "insert into records(entity,owner_id,data,visibility,team_id) values('notes',$1,jsonb_build_object('title','Needle team'),'private',$2) returning id",
    )
    .bind(f.owner)
    .bind(team)
    .fetch_one(&db)
    .await
    .unwrap();
    let personal_public = create_note(&db, f.owner, "Needle public", "public").await;
    let personal_private = create_note(&db, f.owner, "Needle private", "private").await;
    let state = &f.state;
    let admin = Some(f.admin_token.as_str());

    let team_only = call(
        state,
        admin,
        "GET",
        "/content?entity=notes&visibility=team&q=needle",
    )
    .await;
    assert_eq!(ids(&team_only), [team_row.to_string()]);
    let public_only = call(
        state,
        admin,
        "GET",
        "/content?entity=notes&visibility=public&q=needle",
    )
    .await;
    assert_eq!(ids(&public_only), [personal_public.to_string()]);
    // Personal private rows stay out of the team filter, and team rows stay out of the private one.
    let private_only = call(
        state,
        admin,
        "GET",
        "/content?entity=notes&visibility=private&q=needle",
    )
    .await;
    assert_eq!(ids(&private_only), [personal_private.to_string()]);
}
