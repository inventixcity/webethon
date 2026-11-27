//! Integration tests: each runs against a fresh database built from the real migrations.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Query, State},
    http::{Request, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use kernel::{AppState, config::Config, email::LogSender, request::RequestMeta, session};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Semaphore,
};
use tower::ServiceExt;
use uuid::Uuid;

use crate::{geocode::Geocoder, router_with, set_admin_hidden};
use kernel::ErrorCode;

fn app(db: PgPool, geocoder: Option<Geocoder>) -> (Router, Arc<Config>) {
    let config = Arc::new(Config::from_env().unwrap());
    let state = AppState {
        db,
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(Semaphore::new(2)),
    };
    (router_with(geocoder).with_state(state), config)
}

async fn user(db: &PgPool, config: &Config) -> (Uuid, String) {
    let id: Uuid = sqlx::query_scalar("insert into users(email) values($1) returning id")
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

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let content = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            body.to_string()
        }
        None => String::new(),
    };
    let response = app
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

async fn seed_place(
    db: &PgPool,
    owner: Uuid,
    name: &str,
    lat: f64,
    lng: f64,
    visibility: &str,
    category: &str,
) -> Uuid {
    sqlx::query_scalar(
        "insert into places (owner_id, name, lat, lng, visibility, category)
         values ($1, $2, $3, $4, $5, $6) returning id",
    )
    .bind(owner)
    .bind(name)
    .bind(lat)
    .bind(lng)
    .bind(visibility)
    .bind(category)
    .fetch_one(db)
    .await
    .unwrap()
}

fn names(body: &Value) -> Vec<String> {
    body["data"]
        .as_array()
        .unwrap_or_else(|| panic!("no data in response: {body}"))
        .iter()
        .map(|place| place["name"].as_str().unwrap().to_owned())
        .collect()
}

fn create_body(name: &str, lat: f64, lng: f64) -> Value {
    json!({ "name": name, "lat": lat, "lng": lng })
}

#[sqlx::test(migrations = "../../migrations")]
async fn owners_edit_and_others_get_not_found(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;

    let (status, created) = call(
        &app,
        "POST",
        "/places",
        Some(&owner),
        Some(create_body("Harbour cafe", 51.5, -0.1)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["data"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["data"]["mine"], true);
    assert_eq!(created["data"]["visibility"], "private");
    assert!(
        created["data"].get("ownerId").is_none(),
        "owner ids are never sent"
    );

    let path = format!("/places/{id}");
    assert_eq!(
        call(&app, "GET", &path, Some(&owner), None).await.0,
        StatusCode::OK
    );
    // A private place looks exactly like a missing one to everyone else.
    assert_eq!(
        call(&app, "GET", &path, Some(&other), None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &path, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&other),
            Some(json!({"name": "x"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &path, Some(&other), None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", "/places/not-a-uuid", Some(&owner), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // A partial update keeps every field it doesn't mention.
    let (status, updated) = call(
        &app,
        "PATCH",
        &path,
        Some(&owner),
        Some(json!({"name": "Harbour cafe 2", "address": "1 Quay Road"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["data"]["name"], "Harbour cafe 2");
    assert_eq!(updated["data"]["address"], "1 Quay Road");
    assert_eq!(updated["data"]["lat"], 51.5);
    assert_eq!(updated["data"]["visibility"], "private");

    // Once public, others can read it (never edit it).
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&owner),
            Some(json!({"visibility": "public"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, seen) = call(&app, "GET", &path, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["data"]["mine"], false);
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&other),
            Some(json!({"name": "x"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        call(&app, "DELETE", &path, Some(&owner), None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", &path, None, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &path, Some(&owner), None).await.0,
        StatusCode::NOT_FOUND
    );

    // The row stays for recovery, but is marked deleted and not returned anywhere.
    let deleted: bool =
        sqlx::query_scalar("select deleted_at is not null from places where id = $1::uuid")
            .bind(&id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(deleted);
}

#[sqlx::test(migrations = "../../migrations")]
async fn create_and_update_validate_every_field(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;

    let (status, body) = call(&app, "POST", "/places", Some(&token), Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    assert_eq!(body["error"]["details"].as_array().unwrap().len(), 3);

    let bad = [
        json!({"name": "   ", "lat": 1.0, "lng": 1.0}),
        json!({"name": "a".repeat(121), "lat": 1.0, "lng": 1.0}),
        json!({"name": "bad\u{0}name", "lat": 1.0, "lng": 1.0}),
        json!({"name": "ok", "lat": 91.0, "lng": 1.0}),
        json!({"name": "ok", "lat": 1.0, "lng": 181.0}),
        json!({"name": "ok", "lat": 1.0, "lng": 1.0, "visibility": "everyone"}),
        json!({"name": "ok", "lat": 1.0, "lng": 1.0, "description": "d".repeat(2001)}),
        json!({"name": "ok", "lat": 1.0, "lng": 1.0, "address": "a".repeat(301)}),
    ];
    for body in bad {
        let (status, response) =
            call(&app, "POST", "/places", Some(&token), Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["error"]["code"], "VALIDATION_FAILED", "{body}");
    }

    // Unknown fields use the validation envelope.
    let (status, body) = call(
        &app,
        "POST",
        "/places",
        Some(&token),
        Some(json!({"name": "ok", "lat": 1.0, "lng": 1.0, "ownerId": Uuid::new_v4()})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");

    let (status, created) = call(
        &app,
        "POST",
        "/places",
        Some(&token),
        Some(json!({"name": "  Cafe  ", "lat": 1.0, "lng": 1.0, "category": "  Coffee ", "description": "line one\r\nline two"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["data"]["name"], "Cafe");
    assert_eq!(created["data"]["category"], "coffee");
    assert_eq!(created["data"]["description"], "line one\nline two");

    let path = format!("/places/{}", created["data"]["id"].as_str().unwrap());
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&token),
            Some(json!({"lat": 95.0}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(&token),
            Some(json!({"owner": "x"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn map_search_respects_access_and_filters(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (me, mine) = user(&db, &config).await;
    let (other, _) = user(&db, &config).await;
    seed_place(&db, me, "Big Ben cafe", 51.5, -0.1, "public", "coffee").await;
    seed_place(&db, me, "Secret den", 51.5, -0.12, "private", "coffee").await;
    seed_place(&db, other, "Borough market", 51.6, 0.05, "public", "food").await;
    seed_place(&db, other, "Other private", 51.5, -0.11, "private", "food").await;
    seed_place(&db, other, "Outside", 10.0, 10.0, "public", "food").await;
    let view = "/places?bbox=-1,51,1,52";

    let (status, anonymous) = call(&app, "GET", view, None, None).await;
    assert_eq!(status, StatusCode::OK);
    let mut found = names(&anonymous);
    found.sort();
    assert_eq!(found, vec!["Big Ben cafe", "Borough market"]);
    assert_eq!(anonymous["meta"]["truncated"], false);

    let (_, signed_in) = call(&app, "GET", view, Some(&mine), None).await;
    let mut found = names(&signed_in);
    found.sort();
    assert_eq!(found, vec!["Big Ben cafe", "Borough market", "Secret den"]);
    let mine_flags: Vec<bool> = signed_in["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|place| place["mine"].as_bool().unwrap())
        .collect();
    assert_eq!(mine_flags.iter().filter(|flag| **flag).count(), 2);

    let (_, filtered) = call(&app, "GET", "/places?bbox=-1,51,1,52&q=CAFE", None, None).await;
    assert_eq!(names(&filtered), vec!["Big Ben cafe"]);
    let (_, by_category) = call(
        &app,
        "GET",
        "/places?bbox=-1,51,1,52&category=FOOD",
        None,
        None,
    )
    .await;
    assert_eq!(names(&by_category), vec!["Borough market"]);
    // A percent sign is an ordinary character in a search, not a wildcard.
    let (status, literal) = call(&app, "GET", "/places?bbox=-1,51,1,52&q=%25", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(names(&literal).is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn map_search_refuses_bad_viewports_and_options(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;
    for path in [
        "/places",                                 // no viewport at all
        "/places?bbox=0,10,1,5",                   // minLat above maxLat
        "/places?bbox=0,0,1",                      // too few numbers
        "/places?bbox=0,0,1,NaN",                  // NaN
        "/places?bbox=0,0,1,inf",                  // infinity
        "/places?bbox=-1e308,0,1e308,1",           // huge but out of range
        "/places?bbox=0,-91,1,1",                  // latitude out of range
        "/places?bbox=0,0,181,1",                  // longitude out of range
        "/places?bbox=-1,51,1,52&limit=0",         // below the minimum
        "/places?bbox=-1,51,1,52&limit=501",       // above the cap
        "/places?bbox=-1,51,1,52&limit=ten",       // not a number
        "/places?bbox=-1,51,1,52&owner=me",        // unknown option
        "/places?bbox=-1,51,1,52&bbox=-1,51,1,52", // repeated option
    ] {
        let (status, body) = call(&app, "GET", path, Some(&token), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED", "{path}");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn antimeridian_views_match_places_on_both_sides(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner, _) = user(&db, &config).await;
    seed_place(&db, owner, "east of the line", 0.0, 179.9, "public", "").await;
    seed_place(&db, owner, "west of the line", 0.0, -179.9, "public", "").await;
    seed_place(&db, owner, "far away", 0.0, 0.0, "public", "").await;

    let (status, body) = call(&app, "GET", "/places?bbox=170,-1,-170,1", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let mut found = names(&body);
    found.sort();
    assert_eq!(found, vec!["east of the line", "west of the line"]);

    let (_, body) = call(&app, "GET", "/places?bbox=-1,-1,1,1", None, None).await;
    assert_eq!(names(&body), vec!["far away"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn map_results_are_capped_and_say_so(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner, token) = user(&db, &config).await;
    sqlx::query(
        "insert into places (owner_id, name, lat, lng, visibility)
         select $1, 'p' || g, 40.0 + g * 0.0001, 10.0, 'public' from generate_series(1, 501) g",
    )
    .bind(owner)
    .execute(&db)
    .await
    .unwrap();
    let view = "/places?bbox=9,39,11,41";

    let (_, body) = call(&app, "GET", view, Some(&token), None).await;
    assert_eq!(body["data"].as_array().unwrap().len(), 200);
    assert_eq!(body["meta"]["truncated"], true);

    let (_, body) = call(
        &app,
        "GET",
        &format!("{view}&limit=500"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(body["data"].as_array().unwrap().len(), 500);
    assert_eq!(body["meta"]["truncated"], true);
}

#[sqlx::test(migrations = "../../migrations")]
async fn nearby_sorts_by_distance_and_respects_radius(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner, token) = user(&db, &config).await;
    let (other, _) = user(&db, &config).await;
    seed_place(&db, owner, "here", 51.5074, -0.1278, "public", "").await;
    seed_place(&db, owner, "one km", 51.5155, -0.1419, "public", "").await;
    seed_place(&db, owner, "four km", 51.5, -0.19, "public", "").await;
    seed_place(&db, owner, "far", 51.8074, -0.1278, "public", "").await;
    seed_place(&db, other, "hidden", 51.5074, -0.1279, "private", "").await;
    let base = "/places/nearby?lat=51.5074&lng=-0.1278";

    let (status, body) = call(&app, "GET", base, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(names(&body), vec!["here", "one km", "four km"]);
    let distances: Vec<f64> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|place| place["distanceM"].as_f64().unwrap())
        .collect();
    assert_eq!(distances[0], 0.0);
    assert!((1200.0..1500.0).contains(&distances[1]), "{distances:?}");
    assert!((4200.0..4600.0).contains(&distances[2]), "{distances:?}");

    let (_, wide) = call(
        &app,
        "GET",
        &format!("{base}&radiusKm=50"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(names(&wide), vec!["here", "one km", "four km", "far"]);
    let (_, limited) = call(&app, "GET", &format!("{base}&limit=2"), None, None).await;
    assert_eq!(names(&limited), vec!["here", "one km"]);

    for path in [
        "/places/nearby?lat=51.5&lng=-0.1&radiusKm=50.5",
        "/places/nearby?lat=51.5&lng=-0.1&radiusKm=0",
        "/places/nearby?lat=91&lng=0",
        "/places/nearby?lat=51.5",
        "/places/nearby?lat=51.5&lng=-0.1&limit=101",
        "/places/nearby?lat=NaN&lng=0",
    ] {
        assert_eq!(
            call(&app, "GET", path, None, None).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn nearby_handles_the_antimeridian_and_the_poles(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner, token) = user(&db, &config).await;
    seed_place(&db, owner, "across the line", 0.0, 179.95, "public", "").await;
    seed_place(&db, owner, "near the pole", 89.99, 0.0, "public", "").await;

    // About 11 km east across 180 degrees.
    let (_, body) = call(
        &app,
        "GET",
        "/places/nearby?lat=0&lng=-179.95&radiusKm=20",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(names(&body), vec!["across the line"]);
    let (_, body) = call(
        &app,
        "GET",
        "/places/nearby?lat=0&lng=-179.95&radiusKm=5",
        Some(&token),
        None,
    )
    .await;
    assert!(names(&body).is_empty());

    // A search cap of 50 km at 89.9 degrees covers every longitude.
    let (_, body) = call(
        &app,
        "GET",
        "/places/nearby?lat=89.9&lng=90&radiusKm=50",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(names(&body), vec!["near the pole"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn place_count_is_capped_per_owner(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner, token) = user(&db, &config).await;
    sqlx::query(
        "insert into places (owner_id, name, lat, lng)
         select $1, 'p', 1.0, 1.0 from generate_series(1, 500) g",
    )
    .bind(owner)
    .execute(&db)
    .await
    .unwrap();
    let (status, body) = call(
        &app,
        "POST",
        "/places",
        Some(&token),
        Some(create_body("one more", 1.0, 1.0)),
    )
    .await;
    // Documented contract (docs/PLACES.md, docs/API.md): LIMIT_REACHED is 422 everywhere.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "LIMIT_REACHED");
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_log_records_actions_without_place_details(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;
    let (_, created) = call(
        &app,
        "POST",
        "/places",
        Some(&token),
        Some(json!({"name": "Secret spot name", "lat": 1.0, "lng": 1.0})),
    )
    .await;
    let id = created["data"]["id"].as_str().unwrap().to_owned();
    let (action, meta): (String, Value) = sqlx::query_as(
        "select action, meta from audit_log where target_id = $1 and action = 'place.create'",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(action, "place.create");
    assert_eq!(meta, json!({}));
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_saves_checked_answers_per_person(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, first) = user(&db, &config).await;
    let (_, second) = user(&db, &config).await;

    assert_eq!(
        call(&app, "GET", "/onboarding", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = call(&app, "GET", "/onboarding", Some(&first), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"], json!({"answers": {}, "completedAt": null}));

    let (status, saved) = call(
        &app,
        "PUT",
        "/onboarding",
        Some(&first),
        Some(json!({"answers": {"interests": ["music", "food"], "notifications": "important"}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["data"]["completedAt"], Value::Null);

    let (_, completed) = call(
        &app,
        "PUT",
        "/onboarding",
        Some(&first),
        Some(json!({"answers": {"interests": ["music"]}, "completed": true})),
    )
    .await;
    let completed_at = completed["data"]["completedAt"].clone();
    assert!(completed_at.is_string());
    // Saving again later doesn't move the completion time, and an unfinished save can't unset it.
    let (_, later) = call(
        &app,
        "PUT",
        "/onboarding",
        Some(&first),
        Some(json!({"answers": {"interests": ["art"]}, "completed": false})),
    )
    .await;
    assert_eq!(later["data"]["completedAt"], completed_at);
    assert_eq!(later["data"]["answers"], json!({"interests": ["art"]}));

    // The second person starts from nothing.
    let (_, other) = call(&app, "GET", "/onboarding", Some(&second), None).await;
    assert_eq!(other["data"], json!({"answers": {}, "completedAt": null}));
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_refuses_unknown_keys_and_bad_shapes(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;
    let refused = [
        json!({"answers": {"role": "admin"}}),
        json!({"answers": {"interests": "music"}}),
        json!({"answers": {"interests": ["Music"]}}),
        json!({"answers": {"interests": vec!["x"; 13]}}),
        json!({"answers": {"notifications": "always"}}),
        json!({"answers": []}),
        json!({"completed": true}),
    ];
    for body in refused {
        let (status, response) =
            call(&app, "PUT", "/onboarding", Some(&token), Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["error"]["code"], "VALIDATION_FAILED", "{body}");
    }
    let (status, body) = call(
        &app,
        "PUT",
        "/onboarding",
        Some(&token),
        Some(json!({"answers": {}, "owner": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
}

// ---------------------------------------------------------------- geocoder

#[derive(Clone)]
struct Mock {
    hits: Arc<AtomicUsize>,
    other: String,
}

/// `/search` echoes the query back as the place name, so a test can see exactly what arrived.
async fn echo(
    State(mock): State<Mock>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    let query = params.get("q").cloned().unwrap_or_default();
    Json(json!([{ "lat": "51.5", "lon": "-0.1", "display_name": query }]))
}

async fn redirect(State(mock): State<Mock>) -> Response {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    (StatusCode::FOUND, [(header::LOCATION, mock.other.clone())]).into_response()
}

async fn slow(State(mock): State<Mock>) -> Json<Value> {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(5)).await;
    Json(json!([]))
}

async fn big(State(mock): State<Mock>) -> String {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    "x".repeat(70_000)
}

async fn html(State(mock): State<Mock>) -> Html<&'static str> {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    Html("<html>not json</html>")
}

async fn counted(State(mock): State<Mock>) -> Json<Value> {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    Json(json!([]))
}

/// Starts a mock geocoder on a random local port and returns its address and hit counter.
async fn start_mock(other: String) -> (SocketAddr, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let state = Mock {
        hits: hits.clone(),
        other,
    };
    let app = Router::new()
        .route("/search", get(echo))
        .route("/redirect", get(redirect))
        .route("/slow", get(slow))
        .route("/big", get(big))
        .route("/html", get(html))
        .route("/hit", get(counted))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (address, hits)
}

/// A server that answers with `response` verbatim, here used to send a chunked body with no
/// Content-Length, which the mock framework can't produce on demand.
async fn raw_server(response: Vec<u8>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let response = response.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    address
}

fn geocoder(address: SocketAddr, path: &str) -> Geocoder {
    Geocoder::new(&format!("http://{address}{path}"), false).unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn geocoder_sends_one_encoded_query_to_the_configured_path(db: PgPool) {
    let (address, hits) = start_mock("http://127.0.0.1:9/never".into()).await;
    let (app, config) = app(db.clone(), Some(geocoder(address, "/search")));
    let (_, token) = user(&db, &config).await;
    // Everything here must travel inside `q`: no host, path or fragment can be redirected.
    let hostile = "../../hit?x=1&y=2#frag @evil.example";
    let encoded = urlencode(hostile);
    let (status, body) = call(
        &app,
        "GET",
        &format!("/places/geocode?q={encoded}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"][0]["label"], hostile);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn geocoder_caches_normalised_queries_for_a_day(db: PgPool) {
    let (address, hits) = start_mock("http://127.0.0.1:9/never".into()).await;
    let (app, config) = app(db.clone(), Some(geocoder(address, "/search")));
    let (_, token) = user(&db, &config).await;
    let (_, first) = call(&app, "GET", "/places/geocode?q=Paris", Some(&token), None).await;
    let (_, second) = call(
        &app,
        "GET",
        "/places/geocode?q=%20%20paris%20%20",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(first, second);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "the second search came from the cache"
    );

    // An old entry is ignored and refreshed.
    sqlx::query("update geocode_cache set fetched_at = now() - interval '25 hours'")
        .execute(&db)
        .await
        .unwrap();
    let (status, _) = call(&app, "GET", "/places/geocode?q=Paris", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn geocoder_refuses_redirects_slow_and_oversized_answers(db: PgPool) {
    // A redirect points at a second mock, which must never be contacted.
    let (target, target_hits) = start_mock("http://127.0.0.1:9/never".into()).await;
    let (host, _) = start_mock(format!("http://{target}/hit")).await;
    let (_, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;

    for (index, path) in ["/redirect", "/big", "/html", "/slow"]
        .into_iter()
        .enumerate()
    {
        let (app, _) = self::app(db.clone(), Some(geocoder(host, path)));
        let started = Instant::now();
        let (status, body) = call(
            &app,
            "GET",
            &format!("/places/geocode?q=case{index}"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        assert_eq!(body["error"]["code"], "UNAVAILABLE", "{path}");
        assert!(
            !body.to_string().contains("127.0.0.1"),
            "upstream details must not leak"
        );
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "{path} should time out quickly"
        );
    }
    assert_eq!(
        target_hits.load(Ordering::SeqCst),
        0,
        "redirects must not be followed"
    );

    // Chunked output with no Content-Length is still capped while it is read: three 32 KiB chunks
    // are more than the 64 KiB limit.
    let chunk = format!("8000\r\n{}\r\n", "a".repeat(0x8000));
    let body = format!("{chunk}{chunk}{chunk}0\r\n\r\n");
    let raw = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{body}"
    );
    let raw_address = raw_server(raw.into_bytes()).await;
    let (app, _) = self::app(db.clone(), Some(geocoder(raw_address, "/any")));
    let (status, body) = call(&app, "GET", "/places/geocode?q=chunked", Some(&token), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

#[sqlx::test(migrations = "../../migrations")]
async fn geocoder_is_off_without_configuration_and_needs_sign_in(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (_, token) = user(&db, &config).await;
    let (status, body) = call(&app, "GET", "/places/geocode?q=paris", Some(&token), None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "NOT_CONFIGURED");
    assert_eq!(
        call(&app, "GET", "/places/geocode?q=paris", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", "/places/geocode?q=p", Some(&token), None)
            .await
            .0,
        StatusCode::BAD_REQUEST,
        "one character is too short"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn geocoder_is_rate_limited_per_person(db: PgPool) {
    let (address, _) = start_mock("http://127.0.0.1:9/never".into()).await;
    let (app, config) = app(db.clone(), Some(geocoder(address, "/search")));
    let (_, token) = user(&db, &config).await;
    let mut last = StatusCode::OK;
    for index in 0..31 {
        let (status, _) = call(
            &app,
            "GET",
            &format!("/places/geocode?q=query{index}"),
            Some(&token),
            None,
        )
        .await;
        last = status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

fn urlencode(raw: &str) -> String {
    raw.bytes()
        .map(|byte| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[test]
fn geocoder_configuration_is_checked() {
    for (raw, production, ok) in [
        ("https://geo.example.org/search", true, true),
        ("https://geo.example.org/search", false, true),
        ("http://127.0.0.1:8080/search", false, true),
        ("http://geo.example.org/search", true, false),
        ("ftp://geo.example.org/search", false, false),
        ("https://user:pass@geo.example.org/search", false, false),
        ("https://geo.example.org/search#frag", false, false),
        ("not a url", false, false),
    ] {
        assert_eq!(
            Geocoder::new(raw, production).is_ok(),
            ok,
            "{raw} production={production}"
        );
    }
    let error = Geocoder::new("https://u:p@geo.example.org", false)
        .err()
        .unwrap();
    assert!(
        !error.contains("geo.example.org"),
        "the reason must not echo the URL"
    );
}

#[test]
fn geocoder_results_are_checked_and_trimmed() {
    use crate::geocode::{Found, parse_match};
    let good = json!({"lat": "51.5", "lon": "-0.1", "display_name": "  London\u{7}  "});
    assert_eq!(
        parse_match(&good),
        Some(Found {
            label: "London".into(),
            lat: 51.5,
            lng: -0.1
        })
    );
    assert!(parse_match(&json!({"lat": "95", "lon": "0", "display_name": "x"})).is_none());
    assert!(parse_match(&json!({"lat": "NaN", "lon": "0", "display_name": "x"})).is_none());
    assert!(parse_match(&json!({"lat": "1", "lon": "0", "display_name": "   "})).is_none());
    assert!(parse_match(&json!({"lat": "1", "lon": "0"})).is_none());
    let long = json!({"lat": 1, "lon": 0, "display_name": "x".repeat(1000)});
    assert_eq!(parse_match(&long).unwrap().label.chars().count(), 300);
}

#[test]
fn cache_keys_ignore_case_and_spacing() {
    use crate::geocode::cache_key;
    assert_eq!(cache_key("Paris  France"), cache_key(" paris france "));
    assert_ne!(cache_key("Paris"), cache_key("Lyon"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn hidden_places_are_only_visible_to_their_owner(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner_id, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;
    let id = seed_place(&db, owner_id, "Hidden cafe", 51.5, -0.1, "public", "food").await;
    sqlx::query("update places set admin_hidden_at = now() where id = $1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let path = format!("/places/{id}");
    for token in [None, Some(other.as_str())] {
        assert_eq!(
            call(&app, "GET", &path, token, None).await.0,
            StatusCode::NOT_FOUND
        );
        for query in [
            "/places?bbox=-1,51,1,52",
            "/places/nearby?lat=51.5&lng=-0.1&radiusKm=5",
        ] {
            let (status, body) = call(&app, "GET", query, token, None).await;
            assert_eq!(status, StatusCode::OK);
            assert!(names(&body).is_empty());
        }
    }
    for query in [
        path.as_str(),
        "/places?bbox=-1,51,1,52",
        "/places/nearby?lat=51.5&lng=-0.1&radiusKm=5",
    ] {
        let (status, body) = call(&app, "GET", query, Some(&owner), None).await;
        assert_eq!(status, StatusCode::OK);
        let place = if body["data"].is_array() {
            &body["data"][0]
        } else {
            &body["data"]
        };
        assert_eq!(place["moderationHidden"], true);
        assert_eq!(place["name"], "Hidden cafe");
    }
    for payload in [
        json!({"adminHiddenAt": null}),
        json!({"moderationHidden": false}),
        json!({"visibility": "public"}),
    ] {
        assert_eq!(
            call(&app, "PATCH", &path, Some(&owner), Some(payload))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, body) = call(
        &app,
        "PATCH",
        &path,
        Some(&owner),
        Some(json!({"name": "Updated", "visibility": "private"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["moderationHidden"], true);
    assert_eq!(body["data"]["visibility"], "private");
    assert_eq!(body["data"]["name"], "Updated");
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_hide_and_restore_change_what_others_see(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner_id, owner) = user(&db, &config).await;
    let (_, other) = user(&db, &config).await;
    let id = seed_place(&db, owner_id, "Moderated", 51.5, -0.1, "public", "").await;
    let path = format!("/places/{id}");
    let view = "/places?bbox=-1,51,1,52";
    let nearby = "/places/nearby?lat=51.5&lng=-0.1&radiusKm=5";

    let (_, body) = call(&app, "GET", view, None, None).await;
    assert_eq!(names(&body), vec!["Moderated"]);

    let mut tx = db.begin().await.unwrap();
    set_admin_hidden(&mut tx, id, true).await.unwrap();
    tx.commit().await.unwrap();
    let first_hidden_at: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select admin_hidden_at from places where id = $1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(first_hidden_at.is_some());

    for token in [None, Some(other.as_str())] {
        assert_eq!(
            call(&app, "GET", &path, token, None).await.0,
            StatusCode::NOT_FOUND
        );
        for query in [view, nearby] {
            let (status, body) = call(&app, "GET", query, token, None).await;
            assert_eq!(status, StatusCode::OK);
            assert!(names(&body).is_empty(), "{query}");
        }
    }
    let (status, body) = call(&app, "GET", &path, Some(&owner), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["moderationHidden"], true);

    // Hiding again keeps the first timestamp, so the record of when it was hidden stays true.
    let mut tx = db.begin().await.unwrap();
    set_admin_hidden(&mut tx, id, true).await.unwrap();
    tx.commit().await.unwrap();
    let again: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select admin_hidden_at from places where id = $1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(again, first_hidden_at);

    let mut tx = db.begin().await.unwrap();
    set_admin_hidden(&mut tx, id, false).await.unwrap();
    tx.commit().await.unwrap();
    let (_, body) = call(&app, "GET", view, None, None).await;
    assert_eq!(names(&body), vec!["Moderated"]);
    assert_eq!(body["data"][0]["moderationHidden"], false);
    let (status, body) = call(&app, "GET", &path, None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[sqlx::test(migrations = "../../migrations")]
async fn admin_hide_reports_missing_and_deleted_places(db: PgPool) {
    let (app, config) = app(db.clone(), None);
    let (owner_id, owner) = user(&db, &config).await;
    let id = seed_place(&db, owner_id, "Gone soon", 51.5, -0.1, "private", "").await;
    let (status, _) = call(&app, "DELETE", &format!("/places/{id}"), Some(&owner), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let mut tx = db.begin().await.unwrap();
    let missing = set_admin_hidden(&mut tx, Uuid::new_v4(), true).await;
    assert!(matches!(missing, Err(error) if error.code == ErrorCode::NotFound));
    let deleted = set_admin_hidden(&mut tx, id, true).await;
    assert!(matches!(deleted, Err(error) if error.code == ErrorCode::NotFound));
}
