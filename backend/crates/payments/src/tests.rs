//! End-to-end tests against a mocked Stripe API (a local axum server), with the real database.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use kernel::{
    AppState, Viewer,
    config::{Config, Environment},
    email::LogSender,
    viewer::Role,
};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::sync::Semaphore;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    build,
    catalog::Catalog,
    config::{Settings, StripeConfig},
    has_entitlement,
};

const WEBHOOK_SECRET: &str = "whsec_test_unit";
const CATALOG: &str = r#"{"products":[
  {"id":"pro-pass","name":"Pro pass","description":"All of Pro.","priceCents":4900,"currency":"usd","mode":"payment"},
  {"id":"pro-plan","name":"Pro plan","priceCents":900,"currency":"usd","mode":"subscription","interval":"month"}
]}"#;

// ------------------------------------------------------------------ mock Stripe

#[derive(Clone, Debug)]
struct Call {
    method: String,
    path: String,
    form: Vec<(String, String)>,
    auth: String,
    idempotency: Option<String>,
}

#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<Call>>,
    /// Keyed by path below /v1, e.g. "checkout/sessions/cs_1".
    objects: Mutex<HashMap<String, Value>>,
    /// When set, every call fails with 500, as if Stripe were down.
    fail: AtomicBool,
}

impl Mock {
    fn record(
        &self,
        method: &str,
        path: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<(), StatusCode> {
        let form = url::form_urlencoded::parse(body)
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        self.calls.lock().unwrap().push(Call {
            method: method.into(),
            path: path.into(),
            form,
            auth: header(headers, "authorization"),
            idempotency: headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
        });
        if self.fail.load(Ordering::SeqCst) {
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        } else {
            Ok(())
        }
    }

    fn put(&self, key: &str, value: Value) {
        self.objects.lock().unwrap().insert(key.into(), value);
    }

    fn reads_of(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.method == "GET" && call.path == path)
            .count()
    }

    fn last_post(&self, path: &str) -> Call {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|call| call.method == "POST" && call.path == path)
            .cloned()
            .unwrap()
    }
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

fn param(call: &Call, key: &str) -> Option<String> {
    call.form
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

async fn create_session(
    State(mock): State<Arc<Mock>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(status) = mock.record("POST", "/v1/checkout/sessions", &headers, &body) {
        return status.into_response();
    }
    Json(json!({
        "id": "cs_test_new",
        "object": "checkout.session",
        "url": "https://checkout.stripe.test/pay/cs_test_new"
    }))
    .into_response()
}

async fn create_portal(State(mock): State<Arc<Mock>>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(status) = mock.record("POST", "/v1/billing_portal/sessions", &headers, &body) {
        return status.into_response();
    }
    Json(json!({ "id": "bps_1", "url": "https://billing.stripe.test/session/bps_1" }))
        .into_response()
}

async fn read_object(State(mock): State<Arc<Mock>>, uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().to_owned();
    if let Err(status) = mock.record("GET", &path, &headers, b"") {
        return status.into_response();
    }
    let key = path.trim_start_matches("/v1/").to_owned();
    let found = mock.objects.lock().unwrap().get(&key).cloned();
    match found {
        Some(object) => Json(object).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(
                json!({ "error": { "type": "invalid_request_error", "code": "resource_missing" } }),
            ),
        )
            .into_response(),
    }
}

async fn start_mock() -> (Arc<Mock>, String) {
    let mock = Arc::new(Mock::default());
    let app = Router::new()
        .route("/v1/checkout/sessions", post(create_session))
        .route("/v1/billing_portal/sessions", post(create_portal))
        .route("/v1/{*rest}", get(read_object))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (mock, format!("http://{address}"))
}

// ------------------------------------------------------------------ harness

fn app_state(db: PgPool) -> AppState {
    let config = Config {
        environment: Environment::Development,
        bind: "127.0.0.1:0".parse().unwrap(),
        metrics_bind: "127.0.0.1:0".parse().unwrap(),
        database_url: "postgres://unused".into(),
        app_origin: "http://localhost:3000".into(),
        allowed_origins: Default::default(),
        proxy_secret: None,
        trusted_proxy_hops: 0,
        code_pepper: "test-pepper".into(),
        code_pepper_id: "v1".into(),
        code_pepper_keys: std::collections::BTreeMap::new(),
        ip_rate_limit_scale: 100,
        anonymous_sse_per_ip: 5,
        db_max_connections: 10,
        session_cookie: "session".into(),
        session_ttl: std::time::Duration::from_secs(3600),
        secure_cookies: false,
        email_from: "test@example.com".into(),
        resend_api_key: None,
        smtp_url: None,
        admin_emails: Default::default(),
        google: None,
        github: None,
        demo_email: None,
        demo_password: None,
        breach_check: false,
        entities_path: "unused".into(),
        max_body_bytes: 1_048_576,
        request_timeout: std::time::Duration::from_secs(60),
    };
    AppState {
        db,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        email: Arc::new(LogSender),
        hashing: Arc::new(Semaphore::new(1)),
    }
}

struct Harness {
    app: Router,
    mock: Arc<Mock>,
}

async fn harness(db: PgPool, stripe_on: bool) -> Harness {
    let (mock, base) = start_mock().await;
    let stripe = if stripe_on {
        StripeConfig::from_values(
            Some("sk_test_unit"),
            Some(WEBHOOK_SECRET),
            Some(base.as_str()),
            false,
        )
        .unwrap()
    } else {
        None
    };
    let settings = Settings {
        stripe,
        catalog: Catalog::parse(CATALOG).unwrap(),
    };
    let app = build(settings).with_state(app_state(db.clone()));
    Harness { app, mock }
}

async fn user(db: &PgPool) -> Viewer {
    let email = format!("{}@example.com", Uuid::new_v4());
    let id: Uuid = sqlx::query_scalar("insert into users (email) values ($1) returning id")
        .bind(&email)
        .fetch_one(db)
        .await
        .unwrap();
    Viewer {
        id,
        session_id: Uuid::new_v4(),
        email,
        display_name: "Test".into(),
        role: Role::User,
        via_cookie: false,
    }
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    viewer: Option<&Viewer>,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let has_body = body.is_some();
    if has_body {
        builder = builder.header("content-type", "application/json");
    }
    let mut request = builder
        .body(body.map(Body::from).unwrap_or_else(Body::empty))
        .unwrap();
    if let Some(viewer) = viewer {
        request.extensions_mut().insert(viewer.clone());
    }
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn json_bytes(value: Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// The `Stripe-Signature` header Stripe would send for this body.
fn signed(body: &[u8], secret: &str, timestamp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(body);
    format!(
        "t={timestamp},v1={}",
        hex::encode(mac.finalize().into_bytes())
    )
}

fn event_body(id: &str, kind: &str, object: Value, livemode: bool) -> Vec<u8> {
    json_bytes(json!({
        "id": id,
        "object": "event",
        "type": kind,
        "livemode": livemode,
        "data": { "object": object }
    }))
}

async fn deliver(h: &Harness, body: Vec<u8>, secret: &str) -> (StatusCode, Value) {
    let header = signed(&body, secret, now());
    send(
        &h.app,
        Method::POST,
        "/billing/webhook",
        None,
        &[("stripe-signature", header.as_str())],
        Some(body),
    )
    .await
}

fn paid_session(id: &str, user: Uuid, product: &str, mode: &str) -> Value {
    json!({
        "id": id,
        "object": "checkout.session",
        "status": "complete",
        "payment_status": "paid",
        "mode": mode,
        "client_reference_id": user.to_string(),
        "metadata": { "userId": user.to_string(), "productId": product },
        "amount_total": 4900,
        "currency": "usd",
        "customer": "cus_1",
        "subscription": if mode == "subscription" { json!("sub_1") } else { Value::Null }
    })
}

fn subscription(user: Uuid, status: &str, period_end: i64) -> Value {
    json!({
        "id": "sub_1",
        "object": "subscription",
        "status": status,
        "customer": "cus_1",
        "metadata": { "userId": user.to_string(), "productId": "pro-plan" },
        // The newer API shape: the period end sits on each item.
        "items": { "data": [{ "current_period_end": period_end }] }
    })
}

async fn purchase_count(db: &PgPool, user: Uuid) -> i64 {
    sqlx::query_scalar("select count(*) from purchases where user_id = $1")
        .bind(user)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn grant_directly(
    db: &PgPool,
    user: Uuid,
    product: &str,
    status: &str,
    period_end: Option<OffsetDateTime>,
) {
    sqlx::query(
        "insert into entitlements (user_id, product_id, status, current_period_end, synced_at)
         values ($1, $2, $3, $4, now())",
    )
    .bind(user)
    .bind(product)
    .bind(status)
    .bind(period_end)
    .execute(db)
    .await
    .unwrap();
}

// ------------------------------------------------------------------ checkout

#[sqlx::test(migrations = "../../migrations")]
async fn checkout_builds_the_session_from_the_catalog(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        Some(&viewer),
        &[("idempotency-key", "retry-key-12345")],
        Some(json_bytes(json!({ "productId": "pro-pass" }))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["url"],
        "https://checkout.stripe.test/pay/cs_test_new"
    );

    let call = h.mock.last_post("/v1/checkout/sessions");
    assert_eq!(call.auth, "Bearer sk_test_unit");
    assert_eq!(
        call.idempotency.as_deref(),
        Some(format!("checkout-{}-pro-pass-retry-key-12345", viewer.id).as_str())
    );
    assert_eq!(param(&call, "mode").as_deref(), Some("payment"));
    assert_eq!(
        param(&call, "line_items[0][price_data][unit_amount]").as_deref(),
        Some("4900")
    );
    assert_eq!(
        param(&call, "client_reference_id"),
        Some(viewer.id.to_string())
    );
    assert_eq!(param(&call, "customer_email"), Some(viewer.email.clone()));
    assert_eq!(
        param(&call, "metadata[productId]").as_deref(),
        Some("pro-pass")
    );
    assert_eq!(
        param(&call, "success_url").as_deref(),
        Some("http://localhost:3000/app/billing?status=success")
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn checkout_refuses_client_prices_unknown_products_and_strangers(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        Some(&viewer),
        &[],
        Some(json_bytes(
            json!({ "productId": "pro-pass", "priceCents": 1 }),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    for input in [
        json!({}),
        json!({"productId": 1}),
        json!({"productId": "x".repeat(65)}),
    ] {
        let (status, body) = send(
            &h.app,
            Method::POST,
            "/billing/checkout",
            Some(&viewer),
            &[],
            Some(json_bytes(input)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            body["error"]["message"],
            "Please check the highlighted fields."
        );
    }

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        Some(&viewer),
        &[],
        Some(json_bytes(json!({ "productId": "nope" }))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");

    let (status, _) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        None,
        &[],
        Some(json_bytes(json!({ "productId": "pro-pass" }))),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        h.mock.calls.lock().unwrap().is_empty(),
        "no Stripe call for a refused request"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn payments_are_off_without_a_key_and_the_catalog_stays_public(db: PgPool) {
    let h = harness(db.clone(), false).await;
    let viewer = user(&db).await;

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        Some(&viewer),
        &[],
        Some(json_bytes(json!({ "productId": "pro-pass" }))),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "NOT_CONFIGURED");

    let (status, body) = send(&h.app, Method::GET, "/billing/products", None, &[], None).await;
    assert_eq!(status, StatusCode::OK);
    let products = body["data"].as_array().unwrap();
    assert_eq!(products.len(), 2);
    assert!(products[0].get("stripePriceId").is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn people_who_already_own_a_product_are_not_sold_it_again(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;
    grant_directly(&db, viewer.id, "pro-pass", "active", None).await;

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/checkout",
        Some(&viewer),
        &[],
        Some(json_bytes(json!({ "productId": "pro-pass" }))),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(h.mock.calls.lock().unwrap().is_empty());
}

// ------------------------------------------------------------------ webhooks

#[sqlx::test(migrations = "../../migrations")]
async fn a_completed_checkout_grants_access_once(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;
    h.mock.put(
        "checkout/sessions/cs_1",
        paid_session("cs_1", viewer.id, "pro-pass", "payment"),
    );

    // The payload claims a different product; only the re-read session counts.
    let forged = json!({ "id": "cs_1", "object": "checkout.session", "metadata": { "productId": "pro-plan" } });
    let body = event_body("evt_1", "checkout.session.completed", forged, false);
    let (status, reply) = deliver(&h, body.clone(), WEBHOOK_SECRET).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["data"]["outcome"], "done");

    assert!(has_entitlement(&db, viewer.id, "pro-pass").await.unwrap());
    assert!(!has_entitlement(&db, viewer.id, "pro-plan").await.unwrap());
    assert_eq!(purchase_count(&db, viewer.id).await, 1);

    // Stripe redelivers the same event: acknowledged, not processed again.
    let (status, reply) = deliver(&h, body, WEBHOOK_SECRET).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["data"]["outcome"], "duplicate");
    assert_eq!(h.mock.reads_of("/v1/checkout/sessions/cs_1"), 1);
    assert_eq!(purchase_count(&db, viewer.id).await, 1);

    let (status, me) = send(&h.app, Method::GET, "/billing/me", Some(&viewer), &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["data"]["entitlements"][0]["productId"], "pro-pass");
    assert_eq!(me["data"]["entitlements"][0]["active"], true);
    assert_eq!(me["data"]["purchases"][0]["amountCents"], 4900);
}

#[sqlx::test(migrations = "../../migrations")]
async fn bad_signatures_stale_timestamps_and_other_modes_write_nothing(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;
    h.mock.put(
        "checkout/sessions/cs_1",
        paid_session("cs_1", viewer.id, "pro-pass", "payment"),
    );
    let body = event_body(
        "evt_bad",
        "checkout.session.completed",
        json!({ "id": "cs_1" }),
        false,
    );

    let (status, _) = deliver(&h, body.clone(), "whsec_wrong").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let stale = signed(&body, WEBHOOK_SECRET, now() - 600);
    let (status, _) = send(
        &h.app,
        Method::POST,
        "/billing/webhook",
        None,
        &[("stripe-signature", stale.as_str())],
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &h.app,
        Method::POST,
        "/billing/webhook",
        None,
        &[],
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let live = event_body(
        "evt_live",
        "checkout.session.completed",
        json!({ "id": "cs_1" }),
        true,
    );
    let (status, _) = deliver(&h, live, WEBHOOK_SECRET).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let events: i64 = sqlx::query_scalar("select count(*) from payment_events")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(events, 0);
    assert!(
        h.mock.calls.lock().unwrap().is_empty(),
        "nothing was read from Stripe"
    );
    assert!(!has_entitlement(&db, viewer.id, "pro-pass").await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_failed_stripe_read_is_retried_not_lost(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;
    h.mock.put(
        "checkout/sessions/cs_2",
        paid_session("cs_2", viewer.id, "pro-pass", "payment"),
    );
    let body = event_body(
        "evt_2",
        "checkout.session.completed",
        json!({ "id": "cs_2" }),
        false,
    );

    h.mock.fail.store(true, Ordering::SeqCst);
    let (status, _) = deliver(&h, body.clone(), WEBHOOK_SECRET).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "Stripe must see a failure and retry"
    );
    let pending: bool =
        sqlx::query_scalar("select processed_at is null from payment_events where id = 'evt_2'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(pending);
    assert!(!has_entitlement(&db, viewer.id, "pro-pass").await.unwrap());

    h.mock.fail.store(false, Ordering::SeqCst);
    let (status, reply) = deliver(&h, body, WEBHOOK_SECRET).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["data"]["outcome"], "done");
    assert!(has_entitlement(&db, viewer.id, "pro-pass").await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn subscriptions_follow_stripe_through_their_lifecycle(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let viewer = user(&db).await;
    let month = now() + 30 * 86_400;
    h.mock.put(
        "subscriptions/sub_1",
        subscription(viewer.id, "active", month),
    );
    h.mock.put(
        "checkout/sessions/cs_sub",
        paid_session("cs_sub", viewer.id, "pro-plan", "subscription"),
    );

    let started = event_body(
        "evt_s1",
        "checkout.session.completed",
        json!({ "id": "cs_sub" }),
        false,
    );
    assert_eq!(deliver(&h, started, WEBHOOK_SECRET).await.0, StatusCode::OK);
    assert!(has_entitlement(&db, viewer.id, "pro-plan").await.unwrap());

    h.mock.put(
        "subscriptions/sub_1",
        subscription(viewer.id, "past_due", month),
    );
    let updated = event_body(
        "evt_s2",
        "customer.subscription.updated",
        json!({ "id": "sub_1" }),
        false,
    );
    assert_eq!(deliver(&h, updated, WEBHOOK_SECRET).await.0, StatusCode::OK);
    assert!(!has_entitlement(&db, viewer.id, "pro-plan").await.unwrap());

    h.mock.put(
        "subscriptions/sub_1",
        subscription(viewer.id, "active", month),
    );
    h.mock.put(
        "invoices/in_1",
        json!({ "id": "in_1", "object": "invoice", "status": "paid", "subscription": "sub_1", "amount_paid": 900, "currency": "usd" }),
    );
    let paid = event_body("evt_s3", "invoice.paid", json!({ "id": "in_1" }), false);
    assert_eq!(deliver(&h, paid, WEBHOOK_SECRET).await.0, StatusCode::OK);
    assert!(has_entitlement(&db, viewer.id, "pro-plan").await.unwrap());
    assert_eq!(purchase_count(&db, viewer.id).await, 1);

    h.mock.put(
        "subscriptions/sub_1",
        subscription(viewer.id, "canceled", now() - 86_400),
    );
    let deleted = event_body(
        "evt_s4",
        "customer.subscription.deleted",
        json!({ "id": "sub_1" }),
        false,
    );
    assert_eq!(deliver(&h, deleted, WEBHOOK_SECRET).await.0, StatusCode::OK);
    assert!(!has_entitlement(&db, viewer.id, "pro-plan").await.unwrap());

    // The portal still finds the customer after cancellation, so past invoices can be reviewed.
    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/portal",
        Some(&viewer),
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["url"],
        "https://billing.stripe.test/session/bps_1"
    );
    let call = h.mock.last_post("/v1/billing_portal/sessions");
    assert_eq!(param(&call, "customer").as_deref(), Some("cus_1"));
    assert_eq!(
        param(&call, "return_url").as_deref(),
        Some("http://localhost:3000/app/billing")
    );
}

// ------------------------------------------------------------------ my billing and the portal

#[sqlx::test(migrations = "../../migrations")]
async fn admin_overrides_control_access_and_survive_stripe_updates(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let owner = user(&db).await;
    let stranger = user(&db).await;
    grant_directly(&db, owner.id, "pro-pass", "canceled", None).await;
    let future = OffsetDateTime::now_utc() + time::Duration::days(1);
    let past = OffsetDateTime::now_utc() - time::Duration::days(1);

    for (override_status, expiry, expected_status, active) in [
        (Some("active"), None, "active", true),
        (Some("active"), Some(future), "active", true),
        (Some("active"), Some(past), "expired", false),
        (Some("revoked"), None, "revoked", false),
        (None, None, "canceled", false),
    ] {
        sqlx::query("update entitlements set admin_override_status = $1, admin_override_expires_at = $2 where user_id = $3 and product_id = 'pro-pass'")
            .bind(override_status).bind(expiry).bind(owner.id).execute(&db).await.unwrap();
        assert_eq!(
            has_entitlement(&db, owner.id, "pro-pass").await.unwrap(),
            active
        );
        assert!(!has_entitlement(&db, stranger.id, "pro-pass").await.unwrap());
        let (_, me) = send(&h.app, Method::GET, "/billing/me", Some(&owner), &[], None).await;
        let row = &me["data"]["entitlements"][0];
        assert_eq!(row["status"], expected_status);
        assert_eq!(row["active"], active);
        let actual_expiry = row["currentPeriodEnd"].as_str().map(|value| {
            OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).unwrap()
        });
        assert_eq!(
            actual_expiry.map(|value| value.unix_timestamp()),
            expiry.map(|value| value.unix_timestamp())
        );
    }

    sqlx::query("update entitlements set admin_override_status = 'revoked' where user_id = $1")
        .bind(owner.id)
        .execute(&db)
        .await
        .unwrap();
    h.mock.put(
        "checkout/sessions/cs_override",
        paid_session("cs_override", owner.id, "pro-pass", "payment"),
    );
    let body = event_body(
        "evt_override",
        "checkout.session.completed",
        json!({"id": "cs_override", "object": "checkout.session"}),
        false,
    );
    let (status, reply) = deliver(&h, body, WEBHOOK_SECRET).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert!(!has_entitlement(&db, owner.id, "pro-pass").await.unwrap());
    let (_, me) = send(&h.app, Method::GET, "/billing/me", Some(&owner), &[], None).await;
    assert_eq!(me["data"]["entitlements"][0]["status"], "revoked");
    let (_, other) = send(
        &h.app,
        Method::GET,
        "/billing/me",
        Some(&stranger),
        &[],
        None,
    )
    .await;
    assert!(other["data"]["entitlements"].as_array().unwrap().is_empty());
    sqlx::query("update entitlements set admin_override_status = null where user_id = $1")
        .bind(owner.id)
        .execute(&db)
        .await
        .unwrap();
    assert!(has_entitlement(&db, owner.id, "pro-pass").await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn the_portal_needs_a_customer_and_my_billing_is_private(db: PgPool) {
    let h = harness(db.clone(), true).await;
    let owner = user(&db).await;
    let stranger = user(&db).await;
    grant_directly(&db, owner.id, "pro-pass", "active", None).await;
    grant_directly(
        &db,
        owner.id,
        "pro-plan",
        "active",
        Some(OffsetDateTime::now_utc() - time::Duration::days(1)),
    )
    .await;

    let (status, body) = send(
        &h.app,
        Method::POST,
        "/billing/portal",
        Some(&owner),
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    let (status, me) = send(
        &h.app,
        Method::GET,
        "/billing/me",
        Some(&stranger),
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(me["data"]["entitlements"].as_array().unwrap().is_empty());

    let (_, me) = send(&h.app, Method::GET, "/billing/me", Some(&owner), &[], None).await;
    let rows = me["data"]["entitlements"].as_array().unwrap();
    let expired = rows
        .iter()
        .find(|row| row["productId"] == "pro-plan")
        .unwrap();
    assert_eq!(expired["active"], false, "a lapsed period is not access");

    assert!(has_entitlement(&db, owner.id, "pro-pass").await.unwrap());
    assert!(!has_entitlement(&db, owner.id, "pro-plan").await.unwrap());
}
