//! Stripe's webhook. Each event is verified on its raw bytes, claimed once, and then re-read from
//! Stripe before any row changes. The payload only supplies object ids, so a forged or stale payload
//! can't grant anything.
//!
//! A transient failure (Stripe or the database is down) returns 5xx, so Stripe redelivers the event.
//! A permanent problem (unknown product, missing user, object not found) is logged and acknowledged,
//! so it isn't retried forever.

use std::sync::Arc;

use axum::{Extension, Json, body::Bytes, extract::State, http::HeaderMap};
use kernel::{
    AppError, AppResult, AppState,
    request::RequestMeta,
    security::{AuditEntry, audit},
};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    catalog::{Catalog, Mode, Product},
    config::{Settings, not_configured},
    signature,
    store::{self, Grant},
    stripe::{Failure, Stripe, valid_id},
};

#[derive(Deserialize)]
struct Event {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    livemode: bool,
    data: EventData,
}

#[derive(Deserialize)]
struct EventData {
    object: Value,
}

/// How one event ended. Both outcomes are acknowledged to Stripe.
enum Step {
    Done,
    Skipped(&'static str),
}

/// The outcome of re-reading a subscription from Stripe.
enum Synced<'a> {
    Applied { user: Uuid, product: &'a Product },
    Skipped(&'static str),
}

struct Ctx<'a> {
    state: &'a AppState,
    settings: &'a Settings,
    client: Stripe<'a>,
    /// Taken before the first read from Stripe. An older read never overwrites a newer one.
    fetched_at: OffsetDateTime,
}

impl Ctx<'_> {
    /// Reads one object. `None` means Stripe says it doesn't exist; transient trouble is an error.
    async fn fetch(&self, path: &str) -> AppResult<Option<Value>> {
        match self.client.get(path).await {
            Ok(value) => Ok(Some(value)),
            Err(Failure::NotFound) => Ok(None),
            Err(Failure::Unavailable) => Err(Failure::Unavailable.into_app()),
        }
    }
}

pub async fn receive(
    State(state): State<AppState>,
    Extension(settings): Extension<Arc<Settings>>,
    meta: RequestMeta,
    headers: HeaderMap,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> AppResult<Json<Value>> {
    let body = body.map_err(|error| {
        if error.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
            AppError::new(
                kernel::ErrorCode::PayloadTooLarge,
                "That request is too large.",
            )
        } else {
            AppError::bad_request("We couldn't read that request.")
        }
    })?;
    let stripe = settings.stripe.as_ref().ok_or_else(not_configured)?;
    let secret = stripe.webhook_secret.as_ref().ok_or_else(not_configured)?;
    let header = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let now = OffsetDateTime::now_utc().unix_timestamp();
    // The header and body are never logged: the body can hold customer details.
    if let Err(reason) = signature::verify(secret.expose_secret().as_bytes(), header, &body, now) {
        tracing::warn!(?reason, "Stripe webhook refused");
        return Err(AppError::bad_request("That signature doesn't match."));
    }

    let event: Event =
        serde_json::from_slice(&body).map_err(|_| AppError::bad_request("Invalid event."))?;
    if !event.id.starts_with("evt_")
        || !valid_id(&event.id)
        || event.kind.is_empty()
        || event.kind.len() > 128
    {
        return Err(AppError::bad_request("Invalid event."));
    }
    if event.livemode != stripe.live {
        tracing::warn!(event_id = %event.id, "Stripe event is for the other mode");
        return Err(AppError::bad_request(
            "That event is for another Stripe mode.",
        ));
    }

    if store::event_already_processed(&state.db, &event.id, &event.kind, event.livemode).await? {
        return Ok(received("duplicate"));
    }

    let ctx = Ctx {
        state: &state,
        settings: &settings,
        client: Stripe {
            http: &state.http,
            config: stripe,
        },
        fetched_at: OffsetDateTime::now_utc(),
    };
    let step = handle(&ctx, &event).await?;
    store::mark_event_processed(&state.db, &event.id).await?;

    let outcome = match step {
        Step::Done => "done",
        Step::Skipped(reason) => {
            tracing::info!(event_id = %event.id, kind = %event.kind, reason, "Stripe event skipped");
            "skipped"
        }
    };
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "payment.event",
            actor_id: None,
            target_type: Some("payment_event"),
            target_id: Some(event.id.clone()),
            meta: json!({ "type": event.kind, "outcome": outcome }),
        },
    )
    .await;
    Ok(received(outcome))
}

fn received(outcome: &str) -> Json<Value> {
    Json(json!({ "data": { "received": true, "outcome": outcome } }))
}

async fn handle(ctx: &Ctx<'_>, event: &Event) -> AppResult<Step> {
    let object_id = event
        .data
        .object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id));
    let Some(object_id) = object_id else {
        return Ok(Step::Skipped("object has no usable id"));
    };
    match event.kind.as_str() {
        "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
            checkout_completed(ctx, object_id).await
        }
        "invoice.paid" => invoice_paid(ctx, object_id).await,
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted" => match sync_subscription(ctx, object_id).await? {
            Synced::Applied { .. } => Ok(Step::Done),
            Synced::Skipped(reason) => Ok(Step::Skipped(reason)),
        },
        _ => Ok(Step::Skipped("not a billing event")),
    }
}

async fn checkout_completed(ctx: &Ctx<'_>, session_id: &str) -> AppResult<Step> {
    let Some(session) = ctx
        .fetch(&format!("/v1/checkout/sessions/{session_id}"))
        .await?
    else {
        return Ok(Step::Skipped("session not found"));
    };
    if text(&session, "status") != Some("complete") {
        return Ok(Step::Skipped("session isn't complete"));
    }
    if !matches!(
        text(&session, "payment_status"),
        Some("paid" | "no_payment_required")
    ) {
        return Ok(Step::Skipped("session isn't paid yet"));
    }
    // The session must name the same user twice: once as the reference, once in our metadata.
    let user = text(&session, "client_reference_id").and_then(|id| Uuid::parse_str(id).ok());
    let Some(user) = user.filter(|user| metadata_user(&session) == Some(*user)) else {
        return Ok(Step::Skipped("session names no matching user"));
    };
    let Some(product) = metadata_product(&ctx.settings.catalog, &session) else {
        return Ok(Step::Skipped("session names no known product"));
    };
    if text(&session, "mode") != Some(product.mode.as_str()) {
        return Ok(Step::Skipped("session mode doesn't match the product"));
    }
    let customer = text(&session, "customer").filter(|id| valid_id(id));

    match product.mode {
        Mode::Payment => {
            let amount = session
                .get("amount_total")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let currency = text(&session, "currency").unwrap_or_default();
            if !valid_currency(currency) {
                return Ok(Step::Skipped("session has no usable currency"));
            }
            if !store::record_purchase(
                &ctx.state.db,
                user,
                &product.id,
                session_id,
                amount,
                currency,
            )
            .await?
            {
                return Ok(Step::Skipped("user no longer exists"));
            }
            let applied = store::upsert_entitlement(
                &ctx.state.db,
                &Grant {
                    user_id: user,
                    product_id: &product.id,
                    status: "active",
                    current_period_end: None,
                    customer_id: customer,
                    subscription_id: None,
                    synced_at: ctx.fetched_at,
                },
            )
            .await?;
            Ok(if applied {
                Step::Done
            } else {
                Step::Skipped("user no longer exists")
            })
        }
        Mode::Subscription => {
            // The subscription itself is re-read, so the session only supplies its id.
            let Some(subscription) = text(&session, "subscription").filter(|id| valid_id(id))
            else {
                return Ok(Step::Skipped("session has no subscription"));
            };
            match sync_subscription(ctx, subscription).await? {
                Synced::Applied { .. } => Ok(Step::Done),
                Synced::Skipped(reason) => Ok(Step::Skipped(reason)),
            }
        }
    }
}

/// A subscription invoice was paid. The subscription sets the entitlement; the invoice records the money.
async fn invoice_paid(ctx: &Ctx<'_>, invoice_id: &str) -> AppResult<Step> {
    let Some(invoice) = ctx.fetch(&format!("/v1/invoices/{invoice_id}")).await? else {
        return Ok(Step::Skipped("invoice not found"));
    };
    if text(&invoice, "status") != Some("paid") {
        return Ok(Step::Skipped("invoice isn't paid"));
    }
    let Some(subscription) = invoice_subscription(&invoice).filter(|id| valid_id(id)) else {
        // One-off payments are recorded from their Checkout Session instead.
        return Ok(Step::Skipped("invoice isn't for a subscription"));
    };
    let (user, product) = match sync_subscription(ctx, subscription).await? {
        Synced::Applied { user, product } => (user, product),
        Synced::Skipped(reason) => return Ok(Step::Skipped(reason)),
    };
    // A zero-amount invoice (a free trial, say) has nothing to record.
    let amount = invoice
        .get("amount_paid")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let currency = text(&invoice, "currency").unwrap_or_default();
    if amount > 0 {
        if !valid_currency(currency) {
            return Ok(Step::Skipped("invoice has no usable currency"));
        }
        if !store::record_purchase(
            &ctx.state.db,
            user,
            &product.id,
            invoice_id,
            amount,
            currency,
        )
        .await?
        {
            return Ok(Step::Skipped("user no longer exists"));
        }
    }
    Ok(Step::Done)
}

/// Re-reads a subscription and sets the user's entitlement to match Stripe's current answer.
async fn sync_subscription<'a>(ctx: &Ctx<'a>, subscription_id: &str) -> AppResult<Synced<'a>> {
    let Some(subscription) = ctx
        .fetch(&format!("/v1/subscriptions/{subscription_id}"))
        .await?
    else {
        return Ok(Synced::Skipped("subscription not found"));
    };
    let Some(user) = metadata_user(&subscription) else {
        return Ok(Synced::Skipped("subscription names no user"));
    };
    let Some(product) = metadata_product(&ctx.settings.catalog, &subscription) else {
        return Ok(Synced::Skipped("subscription names no known product"));
    };
    if product.mode != Mode::Subscription {
        return Ok(Synced::Skipped("product isn't a subscription"));
    }
    if let Some(expected) = product.stripe_price_id.as_deref()
        && !has_price(&subscription, expected)
    {
        return Ok(Synced::Skipped(
            "subscription price doesn't match the product",
        ));
    }
    let Some(status) = text(&subscription, "status").filter(|status| status.len() <= 32) else {
        return Ok(Synced::Skipped("subscription has no status"));
    };
    let customer = text(&subscription, "customer").filter(|id| valid_id(id));
    let applied = store::upsert_entitlement(
        &ctx.state.db,
        &Grant {
            user_id: user,
            product_id: &product.id,
            status,
            current_period_end: period_end(&subscription),
            customer_id: customer,
            subscription_id: Some(subscription_id),
            synced_at: ctx.fetched_at,
        },
    )
    .await?;
    Ok(if applied {
        Synced::Applied { user, product }
    } else {
        Synced::Skipped("user no longer exists")
    })
}

fn text<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn metadata_user(object: &Value) -> Option<Uuid> {
    object
        .pointer("/metadata/userId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
}

fn metadata_product<'a>(catalog: &'a Catalog, object: &Value) -> Option<&'a Product> {
    object
        .pointer("/metadata/productId")
        .and_then(Value::as_str)
        .and_then(|id| catalog.get(id))
}

/// The subscription id on an invoice. Newer Stripe API versions moved it under `parent`.
fn invoice_subscription(invoice: &Value) -> Option<&str> {
    text(invoice, "subscription").or_else(|| {
        invoice
            .pointer("/parent/subscription_details/subscription")
            .and_then(Value::as_str)
    })
}

/// Newer API versions put `current_period_end` on each subscription item, so both places are read.
fn period_end(subscription: &Value) -> Option<OffsetDateTime> {
    let root = subscription
        .get("current_period_end")
        .and_then(Value::as_i64);
    let from_items = subscription
        .pointer("/items/data")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .filter_map(|item| item.get("current_period_end").and_then(Value::as_i64))
                .max()
        });
    root.or(from_items)
        .and_then(|seconds| OffsetDateTime::from_unix_timestamp(seconds).ok())
}

fn has_price(subscription: &Value, price_id: &str) -> bool {
    subscription
        .pointer("/items/data")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.pointer("/price/id").and_then(Value::as_str) == Some(price_id))
        })
}

fn valid_currency(currency: &str) -> bool {
    currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_lowercase())
}
