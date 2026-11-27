#![allow(clippy::unwrap_used)]
//! Integration tests against a real Postgres (one fresh database per test). They drive the router
//! the way a client would, and read invite tokens out of the emails the server sends.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{
    AppState, Viewer,
    config::Config,
    email::{Email, EmailSender, SendFuture},
    request::RequestMeta,
    session,
    viewer::Role,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Semaphore;
use tower::ServiceExt;
use uuid::Uuid;

use crate::TeamRole;

#[derive(Clone, Default)]
struct Outbox(Arc<Mutex<Vec<Email>>>);

impl EmailSender for Outbox {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            if let Ok(mut sent) = self.0.lock() {
                sent.push(email.clone());
            }
            Ok(())
        })
    }
}

#[derive(Clone)]
struct Who {
    id: Uuid,
    token: String,
}

struct Harness {
    app: Router,
    db: PgPool,
    config: Arc<Config>,
    outbox: Outbox,
}

fn harness(db: PgPool) -> Harness {
    let config = Arc::new(Config::from_env().unwrap());
    let outbox = Outbox::default();
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(outbox.clone()),
        hashing: Arc::new(Semaphore::new(1)),
    };
    Harness {
        app: crate::router().with_state(state),
        db,
        config,
        outbox,
    }
}

impl Harness {
    async fn account(&self, email: &str, name: &str, verified: bool) -> Who {
        let id: Uuid = sqlx::query_scalar(
            "insert into users (email, display_name, email_verified_at)
             values ($1, $2, case when $3 then now() end) returning id",
        )
        .bind(email)
        .bind(name)
        .bind(verified)
        .fetch_one(&self.db)
        .await
        .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, _) = session::create(&self.db, &self.config, id, &meta)
            .await
            .unwrap();
        Who { id, token }
    }

    /// A verified account with a unique address.
    async fn user(&self, name: &str) -> Who {
        let email = format!("{name}-{}@example.com", Uuid::new_v4().simple());
        self.account(&email, name, true).await
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        who: Option<&Who>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(who) = who {
            request = request.header("authorization", format!("Bearer {}", who.token));
        }
        let content = match body {
            Some(value) => {
                request = request.header("content-type", "application/json");
                value.to_string()
            }
            None => String::new(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(content)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn team(&self, owner: &Who, name: &str) -> Uuid {
        let (status, body) = self
            .call("POST", "/teams", Some(owner), Some(json!({ "name": name })))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["data"]["id"].as_str().unwrap().parse().unwrap()
    }

    async fn join(&self, team: Uuid, who: &Who, role: &str) {
        sqlx::query("insert into team_members (team_id, user_id, role) values ($1, $2, $3)")
            .bind(team)
            .bind(who.id)
            .bind(role)
            .execute(&self.db)
            .await
            .unwrap();
    }

    async fn sent(&self) -> usize {
        self.outbox.0.lock().unwrap().len()
    }

    /// Waits for the background email task and returns the newest message.
    async fn next_email(&self, before: usize) -> Email {
        for _ in 0..200 {
            if let Some(email) = self.outbox.0.lock().unwrap().get(before).cloned() {
                return email;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no invite email arrived");
    }

    /// Sends an invite and returns the status, the body and the token from the emailed link.
    async fn invite(
        &self,
        team: Uuid,
        who: &Who,
        email: &str,
        role: &str,
    ) -> (StatusCode, Value, String) {
        let before = self.sent().await;
        let (status, body) = self
            .call(
                "POST",
                &format!("/teams/{team}/invites"),
                Some(who),
                Some(json!({ "email": email, "role": role })),
            )
            .await;
        if status != StatusCode::CREATED {
            return (status, body, String::new());
        }
        let message = self.next_email(before).await;
        let token = message
            .text
            .split("token=")
            .nth(1)
            .unwrap()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        (status, body, token)
    }

    async fn accept(&self, who: &Who, token: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/teams/invites/accept",
            Some(who),
            Some(json!({ "token": token })),
        )
        .await
    }

    async fn owners_of(&self, team: Uuid) -> i64 {
        sqlx::query_scalar(
            "select count(*) from team_members where team_id = $1 and role = 'owner'",
        )
        .bind(team)
        .fetch_one(&self.db)
        .await
        .unwrap()
    }
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

// ------------------------------------------------------------------ roles

#[sqlx::test(migrations = "../../migrations")]
async fn role_matrix_for_reads_settings_and_invites(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let member = h.user("member").await;
    let viewer = h.user("viewer").await;
    let outsider = h.user("outsider").await;
    let team = h.team(&owner, "Matrix").await;
    h.join(team, &admin, "admin").await;
    h.join(team, &member, "member").await;
    h.join(team, &viewer, "viewer").await;
    let base = format!("/teams/{team}");

    // Expected status for: read team, list members, rename, list invites, create invite.
    let cases = [
        (&owner, 200, 200, 200, 200, 201),
        (&admin, 200, 200, 200, 200, 201),
        (&member, 200, 200, 403, 403, 403),
        (&viewer, 200, 200, 403, 403, 403),
        (&outsider, 404, 404, 404, 404, 404),
    ];
    for (who, read, members, rename, invites, create) in cases {
        let who_id = who.id;
        let code = |status: StatusCode| status.as_u16();
        assert_eq!(
            code(h.call("GET", &base, Some(who), None).await.0),
            read,
            "read {who_id}"
        );
        assert_eq!(
            code(
                h.call("GET", &format!("{base}/members"), Some(who), None)
                    .await
                    .0
            ),
            members,
            "members {who_id}"
        );
        assert_eq!(
            code(
                h.call(
                    "PATCH",
                    &base,
                    Some(who),
                    Some(json!({ "name": "Renamed" }))
                )
                .await
                .0
            ),
            rename,
            "rename {who_id}"
        );
        assert_eq!(
            code(
                h.call("GET", &format!("{base}/invites"), Some(who), None)
                    .await
                    .0
            ),
            invites,
            "list invites {who_id}"
        );
        let email = format!("invitee-{}@example.com", Uuid::new_v4().simple());
        let (status, body, _) = h.invite(team, who, &email, "viewer").await;
        assert_eq!(code(status), create, "create invite {who_id}: {body}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn only_the_owner_deletes_and_deleted_teams_disappear(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let member = h.user("member").await;
    let team = h.team(&owner, "Doomed").await;
    h.join(team, &admin, "admin").await;
    h.join(team, &member, "member").await;
    let base = format!("/teams/{team}");

    assert_eq!(
        h.call("DELETE", &base, Some(&member), None).await.0,
        StatusCode::FORBIDDEN
    );
    // The owner is still active, so an admin may not delete the team either.
    assert_eq!(
        h.call("DELETE", &base, Some(&admin), None).await.0,
        StatusCode::FORBIDDEN
    );

    let (_, _, token) = h.invite(team, &owner, "later@example.com", "member").await;
    assert_eq!(
        h.call("DELETE", &base, Some(&owner), None).await.0,
        StatusCode::NO_CONTENT
    );

    assert_eq!(
        h.call("GET", &base, Some(&owner), None).await.0,
        StatusCode::NOT_FOUND
    );
    let (_, list) = h.call("GET", "/teams", Some(&owner), None).await;
    assert_eq!(list["data"].as_array().unwrap().len(), 0);
    let later = h.account("later@example.com", "later", true).await;
    let (status, body) = h.accept(&later, &token).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[sqlx::test(migrations = "../../migrations")]
async fn members_cannot_escalate_or_touch_the_owner(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let member = h.user("member").await;
    let viewer = h.user("viewer").await;
    let team = h.team(&owner, "Ladder").await;
    h.join(team, &admin, "admin").await;
    h.join(team, &member, "member").await;
    h.join(team, &viewer, "viewer").await;
    let member_url = |who: &Who| format!("/teams/{team}/members/{}", who.id);

    // A member can't change anyone, not even themselves.
    let (status, _) = h
        .call(
            "PATCH",
            &member_url(&member),
            Some(&member),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Admins can't create or hand out ownership.
    let (status, body) = h
        .call(
            "PATCH",
            &member_url(&viewer),
            Some(&admin),
            Some(json!({ "role": "owner" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _, _) = h.invite(team, &admin, "x@example.com", "owner").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Admins may manage roles at or below their own.
    let (status, _) = h
        .call(
            "PATCH",
            &member_url(&viewer),
            Some(&admin),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = h
        .call(
            "PATCH",
            &member_url(&member),
            Some(&admin),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // The owner is untouchable by admins.
    let owner_url = member_url(&owner);
    assert_eq!(
        h.call(
            "PATCH",
            &owner_url,
            Some(&admin),
            Some(json!({ "role": "viewer" }))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.call("DELETE", &owner_url, Some(&admin), None).await.0,
        StatusCode::FORBIDDEN
    );

    // The member was demoted to viewer above, so they can't invite or remove anyone.
    let (status, _, _) = h.invite(team, &member, "y@example.com", "viewer").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        h.call("DELETE", &member_url(&admin), Some(&member), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    // The owner can demote an admin, and that admin can then only leave.
    let (status, _) = h
        .call(
            "PATCH",
            &member_url(&admin),
            Some(&owner),
            Some(json!({ "role": "viewer" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.call("DELETE", &member_url(&member), Some(&admin), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.call("DELETE", &member_url(&admin), Some(&admin), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn last_owner_cannot_leave_and_transfer_keeps_one_owner(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let team = h.team(&owner, "Handover").await;
    h.join(team, &admin, "admin").await;
    let base = format!("/teams/{team}");

    assert_eq!(
        h.call(
            "DELETE",
            &format!("{base}/members/{}", owner.id),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.call(
            "DELETE",
            &format!("{base}/members/{}", owner.id),
            Some(&admin),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.call(
            "POST",
            &format!("{base}/transfer"),
            Some(&admin),
            Some(json!({ "userId": owner.id }))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _) = h
        .call(
            "POST",
            &format!("{base}/transfer"),
            Some(&owner),
            Some(json!({ "userId": owner.id })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let stranger = h.user("stranger").await;
    let (status, _) = h
        .call(
            "POST",
            &format!("{base}/transfer"),
            Some(&owner),
            Some(json!({ "userId": stranger.id })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = h
        .call(
            "POST",
            &format!("{base}/transfer"),
            Some(&owner),
            Some(json!({ "userId": admin.id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["role"], "admin");
    assert_eq!(h.owners_of(team).await, 1);

    // The former owner is an admin now and may leave; the new owner may not.
    assert_eq!(
        h.call(
            "DELETE",
            &format!("{base}/members/{}", owner.id),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        h.call(
            "DELETE",
            &format!("{base}/members/{}", admin.id),
            Some(&admin),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.owners_of(team).await, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_transfer_and_leaves_never_leave_the_team_ownerless(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    for round in 0..10 {
        let team = h.team(&owner, &format!("Race {round}")).await;
        h.join(team, &admin, "admin").await;
        let base = format!("/teams/{team}");
        let transfer_url = format!("{base}/transfer");
        let owner_url = format!("{base}/members/{}", owner.id);
        let admin_url = format!("{base}/members/{}", admin.id);
        let (transfer, owner_leaves, admin_leaves) = tokio::join!(
            h.call(
                "POST",
                &transfer_url,
                Some(&owner),
                Some(json!({ "userId": admin.id }))
            ),
            h.call("DELETE", &owner_url, Some(&owner), None),
            h.call("DELETE", &admin_url, Some(&admin), None),
        );
        let owners = h.owners_of(team).await;
        assert_eq!(
            owners, 1,
            "round {round}: {transfer:?} {owner_leaves:?} {admin_leaves:?}"
        );
        // Whatever the order, nobody ever gets a 500.
        for (status, _) in [&transfer, &owner_leaves, &admin_leaves] {
            assert!(status.is_client_error() || status.is_success(), "{status}");
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn non_members_get_the_same_404_as_a_missing_team(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let outsider = h.user("outsider").await;
    let team = h.team(&owner, "Private").await;
    let base = format!("/teams/{team}");
    let missing = format!("/teams/{}", Uuid::new_v4());
    let ghost = Uuid::new_v4();
    // Each call carries a body that is valid for its own endpoint, so the only reason to fail is access.
    type Call = (&'static str, String, Option<Value>);
    let calls = |t: &str| -> Vec<Call> {
        vec![
            ("GET", t.to_string(), None),
            ("GET", format!("{t}/members"), None),
            ("GET", format!("{t}/invites"), None),
            ("PATCH", t.to_string(), Some(json!({ "name": "x" }))),
            ("DELETE", t.to_string(), None),
            (
                "POST",
                format!("{t}/invites"),
                Some(json!({ "email": "a@example.com", "role": "viewer" })),
            ),
            ("DELETE", format!("{t}/invites/{ghost}"), None),
            (
                "PATCH",
                format!("{t}/members/{}", owner.id),
                Some(json!({ "role": "viewer" })),
            ),
            ("DELETE", format!("{t}/members/{}", owner.id), None),
            (
                "POST",
                format!("{t}/transfer"),
                Some(json!({ "userId": owner.id })),
            ),
        ]
    };
    for ((method, real, body), (_, fake, fake_input)) in
        calls(&base).into_iter().zip(calls(&missing))
    {
        let (real_status, real_body) = h.call(method, &real, Some(&outsider), body).await;
        let (fake_status, fake_body) = h.call(method, &fake, Some(&outsider), fake_input).await;
        assert_eq!(
            real_status,
            StatusCode::NOT_FOUND,
            "{method} {real}: {real_body}"
        );
        assert_eq!(real_status, fake_status, "{method} {real}");
        assert_eq!(
            error_code(&real_body),
            error_code(&fake_body),
            "{method} {real}"
        );
    }

    // A deleted account loses its access straight away, and drops off the member list.
    let member = h.user("gone").await;
    h.join(team, &member, "member").await;
    sqlx::query("update users set deleted_at = now() where id = $1")
        .bind(member.id)
        .execute(&h.db)
        .await
        .unwrap();
    // The session lookup skips deleted accounts, so their token is simply signed out.
    assert_eq!(
        h.call("GET", &base, Some(&member), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (_, list) = h
        .call("GET", &format!("{base}/members"), Some(&owner), None)
        .await;
    assert!(
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["userId"] != json!(member.id))
    );
}

// ------------------------------------------------------------------ invites

#[sqlx::test(migrations = "../../migrations")]
async fn invites_match_the_email_and_work_once(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let team = h.team(&owner, "Invites").await;
    let base = format!("/teams/{team}");

    // Bob's account is stored with capitals; the invite is lowercase. Matching ignores case.
    let (status, body, token) = h.invite(team, &owner, "bob@example.com", "member").await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(
        !body.to_string().contains(&token),
        "the response must never carry the token"
    );
    let message = h.outbox.0.lock().unwrap().last().cloned().unwrap();
    assert_eq!(message.to, "bob@example.com");
    assert!(message.text.contains("/app/teams/join?token="));
    assert!(!message.subject.contains(&token));

    let carol = h.account("carol@example.com", "carol", true).await;
    let (status, body) = h.accept(&carol, &token).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (_, list) = h
        .call("GET", &format!("{base}/invites"), Some(&owner), None)
        .await;
    assert_eq!(
        list["data"].as_array().unwrap().len(),
        1,
        "a wrong address must not use the invite"
    );

    let bob = h.account("Bob@Example.com", "bob", true).await;
    let (status, body) = h.accept(&bob, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["role"], "member");
    assert_eq!(body["data"]["memberCount"], 2);
    let (status, body) = h.accept(&bob, &token).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "reuse: {body}");
    assert_eq!(error_code(&body), "NOT_FOUND");

    let (_, members) = h
        .call("GET", &format!("{base}/members"), Some(&owner), None)
        .await;
    let bob_row = members["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["userId"] == json!(bob.id))
        .unwrap();
    assert_eq!(
        bob_row["email"].as_str().unwrap().to_lowercase(),
        "bob@example.com"
    );
    // A viewer can see the member list but not the addresses.
    let viewer = h.user("viewer").await;
    h.join(team, &viewer, "viewer").await;
    let (_, members) = h
        .call("GET", &format!("{base}/members"), Some(&viewer), None)
        .await;
    assert!(members["data"][0].get("email").is_none());

    // Revoked: the link stops working at once.
    let (_, _, revoked_token) = h.invite(team, &owner, "frank@example.com", "viewer").await;
    let frank = h.account("frank@example.com", "frank", true).await;
    let (_, revoke_body) = h
        .call("GET", &format!("{base}/invites"), Some(&owner), None)
        .await;
    let frank_invite = revoke_body["data"].as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        h.call(
            "DELETE",
            &format!("{base}/invites/{frank_invite}"),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        h.accept(&frank, &revoked_token).await.0,
        StatusCode::NOT_FOUND
    );

    // Expired after seven days: the same generic error.
    let (_, _, expired_token) = h.invite(team, &owner, "erin@example.com", "viewer").await;
    sqlx::query("update team_invites set expires_at = now() - interval '1 minute' where email = 'erin@example.com'")
        .execute(&h.db)
        .await
        .unwrap();
    let erin = h.account("erin@example.com", "erin", true).await;
    assert_eq!(
        h.accept(&erin, &expired_token).await.0,
        StatusCode::NOT_FOUND
    );

    // An unverified account with the right address is refused, and the invite stays open.
    let (_, _, pending_token) = h.invite(team, &owner, "dan@example.com", "viewer").await;
    let dan_unverified = h.account("dan@example.com", "dan", false).await;
    let (status, body) = h.accept(&dan_unverified, &pending_token).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "EMAIL_NOT_VERIFIED");

    // Malformed tokens look exactly like unknown ones.
    assert_eq!(h.accept(&erin, "nope").await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        h.accept(&erin, &"a".repeat(43)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.accept(&erin, &"A".repeat(43)).await.0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn reinviting_replaces_the_old_link(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let team = h.team(&owner, "Resend").await;
    let (_, _, first) = h.invite(team, &owner, "gina@example.com", "member").await;
    let (_, _, second) = h.invite(team, &owner, "gina@example.com", "member").await;
    assert_ne!(first, second);
    let gina = h.account("gina@example.com", "gina", true).await;
    assert_eq!(h.accept(&gina, &first).await.0, StatusCode::NOT_FOUND);
    assert_eq!(h.accept(&gina, &second).await.0, StatusCode::OK);
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_existing_member_keeps_their_role_when_accepting(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let team = h.team(&owner, "Keep").await;
    h.join(team, &admin, "admin").await;
    let (_, _, token) = h.invite(team, &owner, "lee@example.com", "viewer").await;
    let lee = h.account("lee@example.com", "lee", true).await;
    h.join(team, &lee, "admin").await;
    let (status, body) = h.accept(&lee, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["role"], "admin", "accepting must not demote");
}

#[sqlx::test(migrations = "../../migrations")]
async fn invites_cannot_be_used_to_spam_one_address(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let team = h.team(&owner, "Spam").await;
    for _ in 0..5 {
        let (status, body, _) = h.invite(team, &owner, "zed@example.com", "viewer").await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let (status, body) = h
        .call(
            "POST",
            &format!("/teams/{team}/invites"),
            Some(&owner),
            Some(json!({ "email": "zed@example.com", "role": "viewer" })),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(error_code(&body), "RATE_LIMITED");
}

// ------------------------------------------------------------------ input and limits

#[sqlx::test(migrations = "../../migrations")]
async fn input_rules_and_team_caps(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let long = "x".repeat(81);
    for name in ["", "   ", "line\nbreak", long.as_str()] {
        let (status, body) = h
            .call(
                "POST",
                "/teams",
                Some(&owner),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}: {body}");
        assert_eq!(error_code(&body), "VALIDATION_FAILED");
    }
    let (status, body) = h
        .call(
            "POST",
            "/teams",
            Some(&owner),
            Some(json!({ "name": "ok", "extra": true })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // Created first, so the owner is at 19 teams when the cap loop starts.
    let mine = h.team(&owner, "Mine").await;
    for index in 0..19 {
        h.team(&owner, &format!("Team {index}")).await;
    }
    let (status, body) = h
        .call(
            "POST",
            "/teams",
            Some(&owner),
            Some(json!({ "name": "One too many" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(error_code(&body), "LIMIT_REACHED");

    let other = h.user("other").await;
    let team = h.team(&other, "Elsewhere").await;
    let (status, body) = h
        .call(
            "POST",
            &format!("/teams/{team}/invites"),
            Some(&owner),
            Some(json!({ "email": "guest@example.com", "role": "viewer" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = h
        .call(
            "POST",
            &format!("/teams/{mine}/invites"),
            Some(&owner),
            Some(json!({ "email": "not-an-email", "role": "viewer" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(error_code(&body), "VALIDATION_FAILED");
    let (status, _) = h.call("GET", "/teams/not-a-uuid", Some(&owner), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "../../migrations")]
async fn member_lists_page_with_stable_cursors(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let team = h.team(&owner, "Paged").await;
    let mut seen = vec![owner.id];
    for index in 0..4 {
        let member = h.user(&format!("m{index}")).await;
        h.join(team, &member, "member").await;
        seen.push(member.id);
    }
    let base = format!("/teams/{team}/members");
    let mut collected = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let path = match &cursor {
            Some(next) => format!("{base}?limit=2&cursor={next}"),
            None => format!("{base}?limit=2"),
        };
        let (status, body) = h.call("GET", &path, Some(&owner), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        pages += 1;
        for row in body["data"].as_array().unwrap() {
            collected.push(row["userId"].as_str().unwrap().to_owned());
        }
        match body["meta"]["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
        assert!(pages < 10, "pagination never ended");
    }
    assert_eq!(pages, 3);
    let mut expected: Vec<String> = seen.iter().map(Uuid::to_string).collect();
    expected.sort();
    collected.sort();
    assert_eq!(collected, expected);

    for junk in ["limit=0", "limit=101", "cursor=garbage", "sort=name"] {
        let (status, _) = h
            .call("GET", &format!("{base}?{junk}"), Some(&owner), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{junk}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn transfer_and_role_changes_are_audited(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let admin = h.user("admin").await;
    let team = h.team(&owner, "Audit").await;
    h.join(team, &admin, "admin").await;
    let base = format!("/teams/{team}");
    h.call(
        "PATCH",
        &format!("{base}/members/{}", admin.id),
        Some(&owner),
        Some(json!({ "role": "member" })),
    )
    .await;
    h.invite(team, &owner, "audit@example.com", "viewer").await;
    h.call(
        "POST",
        &format!("{base}/transfer"),
        Some(&owner),
        Some(json!({ "userId": admin.id })),
    )
    .await;

    let actions: Vec<String> = sqlx::query_scalar(
        "select action from audit_log where target_type = 'team' and target_id = $1 order by id",
    )
    .bind(team.to_string())
    .fetch_all(&h.db)
    .await
    .unwrap();
    assert_eq!(
        actions,
        [
            "team.create",
            "team.member.role",
            "team.invite.create",
            "team.transfer"
        ]
    );
    let leaked: Option<String> = sqlx::query_scalar(
        "select meta::text from audit_log where target_id = $1 and action = 'team.invite.create'",
    )
    .bind(team.to_string())
    .fetch_one(&h.db)
    .await
    .unwrap();
    assert!(
        leaked.is_some_and(|meta| !meta.contains("audit@example.com")),
        "no addresses in the audit log"
    );
}

// ------------------------------------------------------------------ exported helpers

#[sqlx::test(migrations = "../../migrations")]
async fn exported_helpers_match_the_route_rules(db: PgPool) {
    let h = harness(db);
    let owner = h.user("owner").await;
    let member = h.user("member").await;
    let outsider = h.user("outsider").await;
    let team = h.team(&owner, "Exports").await;
    h.join(team, &member, "member").await;
    let as_viewer = |who: &Who| Viewer {
        id: who.id,
        session_id: Uuid::nil(),
        email: String::new(),
        display_name: String::new(),
        role: Role::User,
        via_cookie: false,
    };

    assert_eq!(
        crate::role_of(&h.db, team, owner.id).await.unwrap(),
        Some(TeamRole::Owner)
    );
    assert_eq!(
        crate::role_of(&h.db, team, outsider.id).await.unwrap(),
        None
    );
    let ok = crate::require_role(&h.db, team, &as_viewer(&owner), TeamRole::Admin).await;
    assert_eq!(ok.unwrap(), TeamRole::Owner);
    let forbidden = crate::require_role(&h.db, team, &as_viewer(&member), TeamRole::Admin).await;
    assert_eq!(forbidden.unwrap_err().code, kernel::ErrorCode::Forbidden);
    let hidden = crate::require_role(&h.db, team, &as_viewer(&outsider), TeamRole::Viewer).await;
    assert_eq!(hidden.unwrap_err().code, kernel::ErrorCode::NotFound);
}

#[sqlx::test(migrations = "../../migrations")]
async fn shared_request_validation(db: PgPool) {
    let h = harness(db);
    let owner = h.user("validation").await;
    for (body, path) in [
        (json!({}), "name"),
        (json!({"name":42}), "name"),
        (json!({"name":"A","extra":true}), "extra"),
        (json!({"name":"a".repeat(81)}), "name"),
    ] {
        let (status, value) = h.call("POST", "/teams", Some(&owner), Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            value["error"]["message"],
            "Please check the highlighted fields."
        );
        assert_eq!(value["error"]["details"][0]["path"], path);
    }
    let team = h.team(&owner, "Test").await;
    for query in ["limit=abc", "limit=1&limit=2", "extra=secret", "cursor="] {
        let (status, value) = h
            .call(
                "GET",
                &format!("/teams/{team}/members?{query}"),
                Some(&owner),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            value["error"]["message"],
            "Please check the highlighted fields."
        );
        assert!(!value.to_string().contains("secret"));
    }
}
