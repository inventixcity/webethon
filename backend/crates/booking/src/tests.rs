//! Database-backed tests for the booking API: access rules, DST through the API, parallel
//! double-booking attempts, idempotency, limits, cancellation and pagination.

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use kernel::{
    AppState,
    config::Config,
    email::{Email, EmailSender, SendFuture},
    request::RequestMeta,
    session,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

/// Keeps every email in memory so tests can check who was told what.
#[derive(Clone, Default)]
struct Outbox(Arc<Mutex<Vec<Email>>>);

impl EmailSender for Outbox {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push(email.clone());
            Ok(())
        })
    }
}

impl Outbox {
    /// Background sends run on the test runtime, so give them a few turns before reading.
    async fn sent_to(&self, address: &str) -> Vec<Email> {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|email| email.to == address)
            .cloned()
            .collect()
    }
}

fn app(db: PgPool) -> (Router, Arc<Config>, Outbox) {
    let config = Arc::new(Config::from_env().unwrap());
    let outbox = Outbox::default();
    let state = AppState {
        db,
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(outbox.clone()),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    (crate::router().with_state(state), config, outbox)
}

/// A signed-in user. Returns the id, the session token and the email address.
async fn user(db: &PgPool, config: &Config) -> (Uuid, String, String) {
    let email = format!("{}@example.com", Uuid::new_v4());
    let id: Uuid = sqlx::query_scalar("insert into users (email) values ($1) returning id")
        .bind(&email)
        .fetch_one(db)
        .await
        .unwrap();
    let meta = RequestMeta {
        ip: "127.0.0.1".into(),
        user_agent: String::new(),
        request_id: String::new(),
    };
    let (token, _) = session::create(db, config, id, &meta).await.unwrap();
    (id, token, email)
}

fn request(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    send(app.clone(), request(method, path, token, body, &[])).await
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

/// Rules that open every day from `start` to `end` (minutes written as "HH:MM").
fn every_day(start: &str, end: &str) -> Value {
    json!(
        (0..7)
            .map(|weekday| json!({ "weekday": weekday, "startTime": start, "endTime": end }))
            .collect::<Vec<_>>()
    )
}

async fn create_resource(app: &Router, token: &str, body: Value) -> String {
    let (status, created) = call(app, "POST", "/booking/resources", Some(token), Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    created["data"]["id"].as_str().unwrap().to_owned()
}

async fn set_rules(app: &Router, token: &str, id: &str, rules: Value) {
    let (status, body) = call(
        app,
        "PUT",
        &format!("/booking/resources/{id}/availability"),
        Some(token),
        Some(json!({ "rules": rules })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

fn resource_body(name: &str, zone: &str, slot: i32, capacity: i32, visibility: &str) -> Value {
    json!({
        "name": name,
        "timezone": zone,
        "slotMinutes": slot,
        "capacity": capacity,
        "visibility": visibility,
    })
}

async fn slots(
    app: &Router,
    token: Option<&str>,
    id: &str,
    from: &str,
    to: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "GET",
        &format!("/booking/resources/{id}/slots?from={from}&to={to}"),
        token,
        None,
    )
    .await
}

fn starts_of(body: &Value) -> Vec<String> {
    body["data"]["slots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| slot["startsAt"].as_str().unwrap().to_owned())
        .collect()
}

async fn book(
    app: &Router,
    token: &str,
    id: &str,
    starts: &str,
    seats: i32,
) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/booking/resources/{id}/bookings"),
        Some(token),
        Some(json!({ "startsAt": starts, "seats": seats })),
    )
    .await
}

async fn confirmed_count(db: &PgPool, id: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from booking_bookings where resource_id = $1 and status = 'confirmed'",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(db)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn resources_follow_visibility_and_ownership_rules(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let (_, other, _) = user(&db, &config).await;
    let private = create_resource(
        &app,
        &owner,
        resource_body("Desk", "Europe/London", 60, 1, "private"),
    )
    .await;
    let public = create_resource(
        &app,
        &owner,
        resource_body("Hall", "Europe/London", 60, 40, "public"),
    )
    .await;

    // A private resource is invisible to everyone else, including anonymous visitors.
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{private}"),
            Some(&other),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{private}"),
            None,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{public}"),
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );

    // Someone else can see a public resource but not change it: 403, because they can see it exists.
    let (status, body) = call(
        &app,
        "PATCH",
        &format!("/booking/resources/{public}"),
        Some(&other),
        Some(json!({"name": "Mine now"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/booking/resources/{private}"),
            Some(&other),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            &format!("/booking/resources/{private}/availability"),
            Some(&other),
            Some(json!({"rules": []}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Owner-only data is 404 for everyone else, even on a public resource.
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{public}/availability"),
            Some(&other),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{public}/bookings"),
            Some(&other),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Lists: the owner sees both, the other person only the public one.
    let (_, mine) = call(&app, "GET", "/booking/resources", Some(&owner), None).await;
    assert_eq!(mine["data"].as_array().unwrap().len(), 2);
    let (_, theirs) = call(&app, "GET", "/booking/resources", Some(&other), None).await;
    let names: Vec<&str> = theirs["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Hall"]);
    assert_eq!(theirs["data"][0]["isOwner"], false);

    // Input is strict: unknown fields and bad zones are refused with field details.
    let (status, body) = call(&app, "POST", "/booking/resources", Some(&owner), Some(json!({"name":"x","timezone":"Mars/Olympus","slotMinutes":60,"capacity":1,"extra":true}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(error_code(&body), "VALIDATION_FAILED");
    let (status, body) = call(
        &app,
        "POST",
        "/booking/resources",
        Some(&owner),
        Some(json!({"name":"x","timezone":"Mars/Olympus","slotMinutes":60,"capacity":1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "VALIDATION_FAILED");
    assert_eq!(body["error"]["details"][0]["path"], "timezone");

    // Owners can edit their resource. Time zone names are case-sensitive IANA names.
    let (status, body) = call(
        &app,
        "PATCH",
        &format!("/booking/resources/{private}"),
        Some(&owner),
        Some(json!({"timezone": "Europe/Paris"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["timezone"], "Europe/Paris");
}

#[sqlx::test(migrations = "../../migrations")]
async fn weekly_hours_and_exceptions_shape_the_slots(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(
        &app,
        &owner,
        resource_body("Room", "Europe/London", 60, 1, "public"),
    )
    .await;

    // Monday to Friday, 09:00 to 17:00. 2027-03-01 is a Monday, in GMT.
    let weekdays: Vec<Value> = (1..=5)
        .map(|weekday| json!({"weekday": weekday, "startTime": "09:00", "endTime": "17:00"}))
        .collect();
    set_rules(&app, &owner, &id, json!(weekdays)).await;
    let (status, monday) = slots(&app, None, &id, "2027-03-01", "2027-03-01").await;
    assert_eq!(status, StatusCode::OK, "{monday}");
    assert_eq!(monday["data"]["slots"].as_array().unwrap().len(), 8);
    assert_eq!(
        monday["data"]["slots"][0]["startsAt"],
        "2027-03-01T09:00:00Z"
    );
    assert_eq!(monday["data"]["slots"][0]["localStart"], "09:00");
    assert_eq!(monday["data"]["slots"][0]["seatsLeft"], 1);
    let (_, weekend) = slots(&app, None, &id, "2030-03-09", "2030-03-10").await;
    assert!(weekend["data"]["slots"].as_array().unwrap().is_empty());

    // A closed exception removes the day; a custom window replaces the weekly hours for another.
    let (status, body) = call(
        &app,
        "PUT",
        &format!("/booking/resources/{id}/exceptions/2027-03-01"),
        Some(&owner),
        Some(json!({"closed": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, closed) = slots(&app, None, &id, "2027-03-01", "2027-03-01").await;
    assert!(closed["data"]["slots"].as_array().unwrap().is_empty());
    let (status, _) = call(
        &app,
        "PUT",
        &format!("/booking/resources/{id}/exceptions/2027-03-02"),
        Some(&owner),
        Some(json!({"closed": false, "startTime": "10:00", "endTime": "12:00"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, custom) = slots(&app, None, &id, "2027-03-02", "2027-03-02").await;
    assert_eq!(
        starts_of(&custom),
        vec!["2027-03-02T10:00:00Z", "2027-03-02T11:00:00Z"]
    );

    // The owner sees the rules and exceptions back, in the same shape they were written.
    let (status, settings) = call(
        &app,
        "GET",
        &format!("/booking/resources/{id}/availability"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["data"]["rules"].as_array().unwrap().len(), 5);
    assert_eq!(settings["data"]["exceptions"].as_array().unwrap().len(), 2);

    // Removing the exception brings the weekly hours back.
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/booking/resources/{id}/exceptions/2027-03-01"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, restored) = slots(&app, None, &id, "2027-03-01", "2027-03-01").await;
    assert_eq!(restored["data"]["slots"].as_array().unwrap().len(), 8);
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_hours_and_exceptions_are_refused_with_paths(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "private")).await;
    let rules_path = format!("/booking/resources/{id}/availability");
    let cases = [
        json!({"rules": [{"weekday": 1, "startTime": "17:00", "endTime": "09:00"}]}),
        json!({"rules": [{"weekday": 1, "startTime": "09:00", "endTime": "12:00"}, {"weekday": 1, "startTime": "11:00", "endTime": "13:00"}]}),
        json!({"rules": [{"weekday": 7, "startTime": "09:00", "endTime": "10:00"}]}),
        json!({"rules": [{"weekday": 1, "startTime": "9am", "endTime": "10:00"}]}),
        json!({"rules": [{"weekday": 1, "startTime": "24:00", "endTime": "24:00"}]}),
        json!({"rules": [{"weekday": 1, "startTime": "09:00", "endTime": "10:00", "extra": 1}]}),
    ];
    for case in cases {
        let (status, body) = call(&app, "PUT", &rules_path, Some(&owner), Some(case)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    // Overlapping windows are reported against /rules, and nothing was saved.
    let (_, body) = call(&app, "PUT", &rules_path, Some(&owner), Some(json!({"rules": [{"weekday": 1, "startTime": "09:00", "endTime": "12:00"}, {"weekday": 1, "startTime": "11:00", "endTime": "13:00"}]}))).await;
    assert_eq!(body["error"]["details"][0]["path"], "rules");
    let (_, settings) = call(&app, "GET", &rules_path, Some(&owner), None).await;
    assert!(settings["data"]["rules"].as_array().unwrap().is_empty());

    // Exceptions: closed days carry no hours, open days need both times, and no past dates.
    let exception = format!("/booking/resources/{id}/exceptions/2030-06-01");
    assert_eq!(
        call(
            &app,
            "PUT",
            &exception,
            Some(&owner),
            Some(json!({"closed": true, "startTime": "09:00"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            &exception,
            Some(&owner),
            Some(json!({"closed": false, "startTime": "09:00"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            &exception,
            Some(&owner),
            Some(json!({"closed": false, "startTime": "12:00", "endTime": "09:00"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let unknown = format!(
        "/booking/resources/{}/exceptions/2030-06-01",
        Uuid::new_v4()
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            &unknown,
            Some(&owner),
            Some(json!({"closed": true}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let past = format!("/booking/resources/{id}/exceptions/2020-01-01");
    assert_eq!(
        call(
            &app,
            "PUT",
            &past,
            Some(&owner),
            Some(json!({"closed": true}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let beyond = format!("/booking/resources/{id}/exceptions/2040-01-01");
    assert_eq!(
        call(
            &app,
            "PUT",
            &beyond,
            Some(&owner),
            Some(json!({"closed": true}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let malformed = format!("/booking/resources/{id}/exceptions/2030-6-1");
    assert_eq!(
        call(
            &app,
            "PUT",
            &malformed,
            Some(&owner),
            Some(json!({"closed": true}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn london_and_new_york_clock_changes_are_correct_through_the_api(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let london = create_resource(
        &app,
        &owner,
        resource_body("London", "Europe/London", 60, 1, "public"),
    )
    .await;
    let new_york = create_resource(
        &app,
        &owner,
        resource_body("New York", "America/New_York", 60, 1, "public"),
    )
    .await;
    set_rules(&app, &owner, &london, every_day("00:00", "24:00")).await;
    set_rules(&app, &owner, &new_york, every_day("00:00", "24:00")).await;

    // 2030-03-31: London springs forward (a 23-hour day). 2030-10-27: London falls back (25 hours).
    let (_, spring) = slots(&app, None, &london, "2030-03-31", "2030-03-31").await;
    assert_eq!(spring["data"]["slots"].as_array().unwrap().len(), 23);
    assert_eq!(
        spring["data"]["slots"][0]["startsAt"],
        "2030-03-31T00:00:00Z"
    );
    let (_, fall) = slots(&app, None, &london, "2030-10-27", "2030-10-27").await;
    assert_eq!(fall["data"]["slots"].as_array().unwrap().len(), 25);
    // 2030-03-10 and 2030-11-03 do the same for New York.
    let (_, ny_spring) = slots(&app, None, &new_york, "2030-03-10", "2030-03-10").await;
    assert_eq!(ny_spring["data"]["slots"].as_array().unwrap().len(), 23);
    let (_, ny_fall) = slots(&app, None, &new_york, "2030-11-03", "2030-11-03").await;
    assert_eq!(ny_fall["data"]["slots"].as_array().unwrap().len(), 25);

    // A 09:00 local slot stays 09:00 local either side of the change, and the labels say so.
    set_rules(&app, &owner, &london, every_day("09:00", "10:00")).await;
    let (_, before) = slots(&app, None, &london, "2030-03-30", "2030-03-30").await;
    let (_, after) = slots(&app, None, &london, "2030-04-01", "2030-04-01").await;
    assert_eq!(
        before["data"]["slots"][0]["startsAt"],
        "2030-03-30T09:00:00Z"
    );
    assert_eq!(
        after["data"]["slots"][0]["startsAt"],
        "2030-04-01T08:00:00Z"
    );
    assert_eq!(after["data"]["slots"][0]["localStart"], "09:00");
    assert_eq!(after["data"]["timezone"], "Europe/London");
}

#[sqlx::test(migrations = "../../migrations")]
async fn slot_ranges_are_bounded(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "public")).await;
    assert_eq!(
        slots(&app, None, &id, "2030-03-10", "2030-03-01").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        slots(&app, None, &id, "2030-01-01", "2030-03-04").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        slots(&app, None, &id, "2030-01-01", "2030-03-03").await.0,
        StatusCode::OK
    );
    assert_eq!(
        slots(&app, None, &id, "2030-3-1", "2030-03-02").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        slots(&app, None, &id, "2030-03-01", "").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn single_seat_parallel_requests_book_exactly_once(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(
        &app,
        &owner,
        resource_body("Room", "Europe/London", 60, 1, "public"),
    )
    .await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;

    let mut tasks = Vec::new();
    for _ in 0..20 {
        let (_, token, _) = user(&db, &config).await;
        let request = request(
            "POST",
            &format!("/booking/resources/{id}/bookings"),
            Some(&token),
            Some(json!({ "startsAt": "2030-03-04T09:00:00Z", "seats": 1 })),
            &[],
        );
        tasks.push(tokio::spawn(send(app.clone(), request)));
    }
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap().0);
    }
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        1,
        "{statuses:?}"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        19,
        "{statuses:?}"
    );
    assert_eq!(confirmed_count(&db, &id).await, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn multi_seat_parallel_requests_never_exceed_capacity(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(
        &app,
        &owner,
        resource_body("Class", "Europe/London", 60, 3, "public"),
    )
    .await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;

    // 20 single-seat requests into 3 seats: exactly 3 get in.
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let (_, token, _) = user(&db, &config).await;
        let request = request(
            "POST",
            &format!("/booking/resources/{id}/bookings"),
            Some(&token),
            Some(json!({"startsAt": "2030-03-04T09:00:00Z", "seats": 1})),
            &[],
        );
        tasks.push(tokio::spawn(send(app.clone(), request)));
    }
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap().0);
    }
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        3,
        "{statuses:?}"
    );
    assert_eq!(confirmed_count(&db, &id).await, 3);
    let (_, after) = slots(&app, None, &id, "2030-03-04", "2030-03-04").await;
    assert_eq!(after["data"]["slots"][0]["seatsLeft"], 0);
    assert_eq!(after["data"]["slots"][1]["seatsLeft"], 3);

    // A 2-seat booking on a fresh slot leaves room for one more seat only.
    let (_, token, _) = user(&db, &config).await;
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T10:00:00Z", 2).await.0,
        StatusCode::CREATED
    );
    let (_, other, _) = user(&db, &config).await;
    assert_eq!(
        book(&app, &other, &id, "2030-03-04T10:00:00Z", 2).await.0,
        StatusCode::CONFLICT
    );
    let (_, last, _) = user(&db, &config).await;
    assert_eq!(
        book(&app, &last, &id, "2030-03-04T10:00:00Z", 1).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        book(&app, &last, &id, "2030-03-04T10:00:00Z", 3).await.0,
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn database_refuses_overlapping_exclusive_bookings(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    let (_, first, _) = user(&db, &config).await;
    assert_eq!(
        book(&app, &first, &id, "2030-03-04T09:00:00Z", 1).await.0,
        StatusCode::CREATED
    );

    // Bypass the application check: the exclusion constraint alone must still stop an overlap.
    let (booker, _, _) = user(&db, &config).await;
    let raw = sqlx::query(
        "insert into booking_bookings (resource_id, booker_id, starts_at, ends_at, seats, exclusive)
         values ($1, $2, '2030-03-04T09:30:00Z', '2030-03-04T10:30:00Z', 1, true)",
    )
    .bind(Uuid::parse_str(&id).unwrap())
    .bind(booker)
    .execute(&db)
    .await;
    let error = raw.unwrap_err();
    let code = match &error {
        sqlx::Error::Database(database) => database.code().map(|code| code.to_string()),
        _ => None,
    };
    assert_eq!(code.as_deref(), Some("23P01"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn bookings_must_be_real_future_slots(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(
        &app,
        &owner,
        resource_body("Room", "Europe/London", 60, 2, "public"),
    )
    .await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    let (_, token, _) = user(&db, &config).await;

    // In the past.
    let (status, body) = book(&app, &token, &id, "2020-01-01T09:00:00Z", 1).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"][0]["path"], "startsAt");
    // Off the grid, outside hours, and with no offset.
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T09:30:00Z", 1).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T18:00:00Z", 1).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T09:00:00", 1).await.0,
        StatusCode::BAD_REQUEST
    );
    // More seats than the resource has, and no seats at all.
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T09:00:00Z", 3).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        book(&app, &token, &id, "2030-03-04T09:00:00Z", 0).await.0,
        StatusCode::BAD_REQUEST
    );
    // The note has a limit and rejects control characters.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/booking/resources/{id}/bookings"),
        Some(&token),
        Some(json!({"startsAt": "2030-03-04T09:00:00Z", "note": "x".repeat(501)})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "POST",
        &format!("/booking/resources/{id}/bookings"),
        Some(&token),
        Some(json!({"startsAt": "2030-03-04T09:00:00Z", "note": "bad\u{7}"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(confirmed_count(&db, &id).await, 0);

    // The same time, valid, is accepted, and it shows in the booker's list with the resource zone.
    let (status, created) = book(&app, &token, &id, "2030-03-04T09:00:00Z", 1).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["data"]["resourceTimezone"], "Europe/London");
    assert_eq!(created["data"]["status"], "confirmed");
}

#[sqlx::test(migrations = "../../migrations")]
async fn idempotency_replays_and_refuses_reuse_with_different_body(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    let (_, token, _) = user(&db, &config).await;
    let path = format!("/booking/resources/{id}/bookings");
    let body = json!({"startsAt": "2030-03-04T09:00:00Z"});

    let first = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(body.clone()),
            &[("idempotency-key", "retry-key-001")],
        ),
    )
    .await;
    assert_eq!(first.0, StatusCode::CREATED);
    let replay = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(body),
            &[("idempotency-key", "retry-key-001")],
        ),
    )
    .await;
    assert_eq!(replay.0, StatusCode::CREATED);
    assert_eq!(replay.1["data"]["id"], first.1["data"]["id"]);
    assert_eq!(confirmed_count(&db, &id).await, 1);

    let other = json!({"startsAt": "2030-03-04T10:00:00Z"});
    let (status, body) = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(other),
            &[("idempotency-key", "retry-key-001")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&body), "IDEMPOTENCY_MISMATCH");

    // Keys are validated like the records crate's.
    let (status, _) = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(json!({"startsAt": "2030-03-04T11:00:00Z"})),
            &[("idempotency-key", "short")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A failed request leaves no key behind, so the retry can succeed.
    let (status, _) = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(json!({"startsAt": "2020-03-04T09:00:00Z"})),
            &[("idempotency-key", "retry-key-002")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        app.clone(),
        request(
            "POST",
            &path,
            Some(&token),
            Some(json!({"startsAt": "2030-03-04T11:00:00Z"})),
            &[("idempotency-key", "retry-key-002")],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn booker_limit_is_ten_upcoming_per_resource(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Tutor", "UTC", 60, 1, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "23:00")).await;
    let (_, token, _) = user(&db, &config).await;
    for hour in 9..19 {
        let starts = format!("2030-03-04T{hour:02}:00:00Z");
        assert_eq!(
            book(&app, &token, &id, &starts, 1).await.0,
            StatusCode::CREATED
        );
    }
    let (status, body) = book(&app, &token, &id, "2030-03-04T19:00:00Z", 1).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(error_code(&body), "LIMIT_REACHED");
    // The limit is per resource: another resource is still open to them.
    let other_resource = create_resource(
        &app,
        &owner,
        resource_body("Tutor 2", "UTC", 60, 1, "public"),
    )
    .await;
    set_rules(&app, &owner, &other_resource, every_day("09:00", "23:00")).await;
    assert_eq!(
        book(&app, &token, &other_resource, "2030-03-04T19:00:00Z", 1)
            .await
            .0,
        StatusCode::CREATED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn booking_lists_hide_other_peoples_bookings_and_contact_details(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let (_, booker, booker_email) = user(&db, &config).await;
    let (_, stranger, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Table", "UTC", 60, 1, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    let (status, created) = book(&app, &booker, &id, "2030-03-04T12:00:00Z", 1).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");

    let (_, mine) = call(&app, "GET", "/booking/bookings", Some(&booker), None).await;
    assert_eq!(mine["data"].as_array().unwrap().len(), 1);
    let (_, none) = call(&app, "GET", "/booking/bookings", Some(&stranger), None).await;
    assert!(none["data"].as_array().unwrap().is_empty());

    // The owner sees who booked (by display name) but never the booker's email address.
    let (status, owner_view) = call(
        &app,
        "GET",
        &format!("/booking/resources/{id}/bookings"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(owner_view["data"].as_array().unwrap().len(), 1);
    assert!(!owner_view.to_string().contains(&booker_email));
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{id}/bookings"),
            Some(&stranger),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Cancelling someone else's booking is a 404, and does not reveal that it exists.
    let booking_id = created["data"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/booking/bookings/{booking_id}/cancel"),
            Some(&stranger),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/booking/bookings/{}/cancel", Uuid::new_v4()),
            Some(&stranger),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/booking/bookings/not-a-uuid/cancel",
            Some(&stranger),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn cancellation_rules_for_bookers_owners_and_started_bookings(db: PgPool) {
    let (app, config, outbox) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let (booker_id, booker, booker_email) = user(&db, &config).await;
    let id = create_resource(
        &app,
        &owner,
        resource_body("Room", "Europe/London", 60, 1, "public"),
    )
    .await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;

    // The booker cancels: the slot frees up, a second cancel is a harmless no-op, and no email is sent to them.
    let (_, first) = book(&app, &booker, &id, "2030-03-04T09:00:00Z", 1).await;
    let booking = first["data"]["id"].as_str().unwrap().to_owned();
    let (status, cancelled) = call(
        &app,
        "POST",
        &format!("/booking/bookings/{booking}/cancel"),
        Some(&booker),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["data"]["status"], "cancelled");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/booking/bookings/{booking}/cancel"),
            Some(&booker),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(confirmed_count(&db, &id).await, 0);
    let (_, after) = slots(&app, None, &id, "2030-03-04", "2030-03-04").await;
    assert_eq!(after["data"]["slots"][0]["seatsLeft"], 1);
    assert!(
        outbox
            .sent_to(&booker_email)
            .await
            .iter()
            .any(|email| email.subject.starts_with("Booked"))
    );
    assert!(
        !outbox
            .sent_to(&booker_email)
            .await
            .iter()
            .any(|email| email.subject.starts_with("Cancelled"))
    );

    // The owner cancels someone else's booking: the booker is told.
    let (_, second) = book(&app, &booker, &id, "2030-03-04T10:00:00Z", 1).await;
    let second = second["data"]["id"].as_str().unwrap().to_owned();
    let (status, _) = call(
        &app,
        "POST",
        &format!("/booking/bookings/{second}/cancel"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let emails = outbox.sent_to(&booker_email).await;
    assert!(
        emails
            .iter()
            .any(|email| email.subject.starts_with("Cancelled") && email.text.contains("Room"))
    );

    // A booking that has already started can't be cancelled, even by the owner.
    let started: Uuid = sqlx::query_scalar(
        "insert into booking_bookings (resource_id, booker_id, starts_at, ends_at, seats, exclusive)
         values ($1, $2, now() - interval '2 hours', now() - interval '1 hour', 1, true) returning id",
    )
    .bind(Uuid::parse_str(&id).unwrap())
    .bind(booker_id)
    .fetch_one(&db)
    .await
    .unwrap();
    let (status, body) = call(
        &app,
        "POST",
        &format!("/booking/bookings/{started}/cancel"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
}

#[sqlx::test(migrations = "../../migrations")]
async fn deleting_a_resource_cancels_its_future_bookings_and_tells_bookers(db: PgPool) {
    let (app, config, outbox) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let (_, booker, booker_email) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Hall", "UTC", 60, 5, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    assert_eq!(
        book(&app, &booker, &id, "2030-03-04T09:00:00Z", 1).await.0,
        StatusCode::CREATED
    );

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/booking/resources/{id}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(confirmed_count(&db, &id).await, 0);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/booking/resources/{id}"),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(
        outbox
            .sent_to(&booker_email)
            .await
            .iter()
            .any(|email| email.subject.starts_with("Cancelled"))
    );
    // The booker still sees the booking in their history, now cancelled.
    let (_, mine) = call(&app, "GET", "/booking/bookings", Some(&booker), None).await;
    assert_eq!(mine["data"][0]["status"], "cancelled");
}

#[sqlx::test(migrations = "../../migrations")]
async fn booking_lists_paginate_and_reject_foreign_cursors(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let (_, booker, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "public")).await;
    set_rules(&app, &owner, &id, every_day("09:00", "17:00")).await;
    for hour in [9, 10, 11] {
        assert_eq!(
            book(
                &app,
                &booker,
                &id,
                &format!("2030-03-04T{hour:02}:00:00Z"),
                1
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }

    let (_, page_one) = call(
        &app,
        "GET",
        "/booking/bookings?limit=2",
        Some(&booker),
        None,
    )
    .await;
    assert_eq!(page_one["data"].as_array().unwrap().len(), 2);
    let cursor = page_one["meta"]["nextCursor"].as_str().unwrap().to_owned();
    let (_, page_two) = call(
        &app,
        "GET",
        &format!("/booking/bookings?limit=2&cursor={cursor}"),
        Some(&booker),
        None,
    )
    .await;
    assert_eq!(page_two["data"].as_array().unwrap().len(), 1);
    assert!(page_two["meta"]["nextCursor"].is_null());
    assert_ne!(page_one["data"][0]["id"], page_two["data"][0]["id"]);

    // A cursor from one list doesn't work on another; bad limits and filters are refused.
    let (status, _) = call(
        &app,
        "GET",
        &format!("/booking/resources/{id}/bookings?cursor={cursor}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(
            &app,
            "GET",
            "/booking/bookings?limit=0",
            Some(&booker),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/booking/bookings?when=someday",
            Some(&booker),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, past) = call(
        &app,
        "GET",
        "/booking/bookings?when=past",
        Some(&booker),
        None,
    )
    .await;
    assert!(past["data"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn anonymous_and_malformed_requests_get_the_error_envelope(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, owner, _) = user(&db, &config).await;
    let id = create_resource(&app, &owner, resource_body("Room", "UTC", 60, 1, "public")).await;

    let (status, body) = call(&app, "GET", "/booking/bookings", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "UNAUTHENTICATED");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/booking/resources/{id}/bookings"),
            None,
            Some(json!({"startsAt":"2030-03-04T09:00:00Z"}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );

    // A body without a JSON content type is refused in our envelope, not as plain text.
    let (_, token, _) = user(&db, &config).await;
    let bare = Request::builder()
        .method("POST")
        .uri(format!("/booking/resources/{id}/bookings"))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from("{}"))
        .unwrap();
    let (status, body) = send(app.clone(), bare).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(error_code(&body), "UNSUPPORTED_MEDIA_TYPE");
    let (status, body) = send(
        app.clone(),
        request(
            "POST",
            &format!("/booking/resources/{id}/bookings"),
            Some(&token),
            Some(json!({"startsAt": "2030-03-04T09:00:00Z", "seats": "two"})),
            &[],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "VALIDATION_FAILED");
    assert_eq!(
        call(
            &app,
            "GET",
            "/booking/resources/not-a-uuid/slots?from=2030-03-04&to=2030-03-04",
            None,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn request_extraction_uses_validation_envelope(db: PgPool) {
    let (app, config, _) = app(db.clone());
    let (_, token, _) = user(&db, &config).await;
    for body in [json!({}), json!({"name": 42}), json!({"unknown": true})] {
        let (status, result) =
            call(&app, "POST", "/booking/resources", Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(result["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            result["error"]["message"],
            "Please check the highlighted fields."
        );
        assert!(result["error"]["details"].is_array());
    }
    for path in [
        "/booking/resources?limit=no",
        "/booking/resources?unexpected=x",
        "/booking/resources?limit=101",
    ] {
        let (status, result) = call(&app, "GET", path, Some(&token), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(result["error"]["code"], "VALIDATION_FAILED");
    }
    let (status, _) = call(
        &app,
        "GET",
        "/booking/resources/not-a-uuid",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
