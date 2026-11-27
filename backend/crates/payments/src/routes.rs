//! The browser-facing billing routes: products, checkout, my billing, and the customer portal.
//! Clients send product ids only. Prices and names always come from the catalog.

use kernel::extract::Json;
use std::{sync::Arc, time::Duration};

use axum::{Extension, extract::State, http::HeaderMap};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer, crypto,
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    catalog::{Mode, Product},
    config::{Settings, not_configured},
    store,
    stripe::{Failure, Stripe},
};

/// Creating Checkout Sessions costs Stripe money, so each user gets a small budget.
const CHECKOUT_LIMIT: Limit = Limit {
    limit: 10,
    window: Duration::from_secs(15 * 60),
};
const PORTAL_LIMIT: Limit = Limit {
    limit: 20,
    window: Duration::from_secs(15 * 60),
};

pub async fn products(Extension(settings): Extension<Arc<Settings>>) -> Json<Value> {
    Json(json!({ "data": settings.catalog.public() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckoutInput {
    product_id: String,
}

pub async fn checkout(
    State(state): State<AppState>,
    Extension(settings): Extension<Arc<Settings>>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
    Json(input): Json<CheckoutInput>,
) -> AppResult<Json<Value>> {
    if !(2..=64).contains(&input.product_id.len()) {
        return Err(unknown_product());
    }
    let stripe = settings.stripe.as_ref().ok_or_else(not_configured)?;
    let product = settings
        .catalog
        .get(&input.product_id)
        .ok_or_else(unknown_product)?;
    if store::has_entitlement(&state.db, viewer.id, &product.id).await? {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "You already have access to this.",
        ));
    }
    enforce_rate_limit(
        &state.db,
        &format!("payments:checkout:{}", viewer.id),
        CHECKOUT_LIMIT,
    )
    .await?;

    // The client's key only makes retries safe. It's scoped to this user and product, so one
    // user's key can never replay another user's session.
    let key = idempotency_key(&headers)?;
    let params = checkout_params(product, viewer.id, &viewer.email, &state.config.app_origin);
    let reply = Stripe {
        http: &state.http,
        config: stripe,
    }
    .post(
        "/v1/checkout/sessions",
        &params,
        Some(&format!("checkout-{}-{}-{key}", viewer.id, product.id)),
    )
    .await
    .map_err(Failure::into_app)?;
    let url = reply
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| Failure::Unavailable.into_app())?;

    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "payment.checkout_started",
            actor_id: Some(viewer.id),
            target_type: Some("product"),
            target_id: Some(product.id.clone()),
            meta: json!({}),
        },
    )
    .await;
    Ok(Json(json!({ "data": { "url": url } })))
}

pub async fn me(State(state): State<AppState>, viewer: Viewer) -> AppResult<Json<Value>> {
    let entitlements = store::entitlements_for(&state.db, viewer.id).await?;
    let purchases = store::purchases_for(&state.db, viewer.id).await?;
    Ok(Json(json!({
        "data": { "entitlements": entitlements, "purchases": purchases }
    })))
}

pub async fn portal(
    State(state): State<AppState>,
    Extension(settings): Extension<Arc<Settings>>,
    viewer: Viewer,
) -> AppResult<Json<Value>> {
    let stripe = settings.stripe.as_ref().ok_or_else(not_configured)?;
    enforce_rate_limit(
        &state.db,
        &format!("payments:portal:{}", viewer.id),
        PORTAL_LIMIT,
    )
    .await?;
    let customer = store::portal_customer(&state.db, viewer.id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::NotFound,
                "We couldn't find a subscription to manage.",
            )
        })?;
    let params = vec![
        ("customer".to_owned(), customer),
        (
            "return_url".to_owned(),
            format!("{}/app/billing", state.config.app_origin),
        ),
    ];
    let reply = Stripe {
        http: &state.http,
        config: stripe,
    }
    .post("/v1/billing_portal/sessions", &params, None)
    .await
    .map_err(Failure::into_app)?;
    let url = reply
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| Failure::Unavailable.into_app())?;
    Ok(Json(json!({ "data": { "url": url } })))
}

fn unknown_product() -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": "productId", "message": "Choose a product from the list." }]))
}

/// The client may send its own key so a retried click doesn't open a second session.
fn idempotency_key(headers: &HeaderMap) -> AppResult<String> {
    let bad = || AppError::bad_request("Invalid Idempotency-Key.");
    match headers.get("idempotency-key") {
        None => Ok(crypto::new_token().0),
        Some(value) => {
            let text = value.to_str().map_err(|_| bad())?;
            let valid = (8..=128).contains(&text.len())
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
            if valid {
                Ok(text.to_owned())
            } else {
                Err(bad())
            }
        }
    }
}

/// Everything Checkout needs, built from the catalog. Pure, so the shape is unit-tested.
pub fn checkout_params(
    product: &Product,
    user: Uuid,
    email: &str,
    origin: &str,
) -> Vec<(String, String)> {
    let user = user.to_string();
    let mut params: Vec<(String, String)> = vec![
        ("mode".into(), product.mode.as_str().into()),
        (
            "success_url".into(),
            format!("{origin}/app/billing?status=success"),
        ),
        (
            "cancel_url".into(),
            format!("{origin}/app/billing?status=cancelled"),
        ),
        ("client_reference_id".into(), user.clone()),
        ("customer_email".into(), email.into()),
        ("metadata[userId]".into(), user.clone()),
        ("metadata[productId]".into(), product.id.clone()),
        ("line_items[0][quantity]".into(), "1".into()),
    ];
    match &product.stripe_price_id {
        Some(price) => params.push(("line_items[0][price]".into(), price.clone())),
        None => {
            params.push((
                "line_items[0][price_data][currency]".into(),
                product.currency.clone(),
            ));
            params.push((
                "line_items[0][price_data][unit_amount]".into(),
                product.price_cents.to_string(),
            ));
            params.push((
                "line_items[0][price_data][product_data][name]".into(),
                product.name.clone(),
            ));
            if !product.description.is_empty() {
                params.push((
                    "line_items[0][price_data][product_data][description]".into(),
                    product.description.clone(),
                ));
            }
            if let Some(interval) = product.interval {
                params.push((
                    "line_items[0][price_data][recurring][interval]".into(),
                    interval.as_str().into(),
                ));
            }
        }
    }
    // Webhooks re-read the payment or subscription, so our ids go on that object too.
    let scope = match product.mode {
        Mode::Payment => "payment_intent_data",
        Mode::Subscription => "subscription_data",
    };
    params.push((format!("{scope}[metadata][userId]"), user));
    params.push((format!("{scope}[metadata][productId]"), product.id.clone()));
    params
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;

    #[test]
    fn checkout_uses_catalog_prices_and_scopes_metadata_by_mode() {
        let catalog = Catalog::parse(
            r#"{"products":[
              {"id":"pro-pass","name":"Pro pass","description":"All of Pro.","priceCents":4900,"currency":"usd","mode":"payment"},
              {"id":"pro-plan","name":"Pro plan","priceCents":900,"currency":"usd","mode":"subscription","interval":"month"}
            ]}"#,
        )
        .unwrap();
        let user = Uuid::new_v4();
        let find = |params: &[(String, String)], key: &str| {
            params
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };

        let pass = checkout_params(
            catalog.get("pro-pass").unwrap(),
            user,
            "a@example.com",
            "http://localhost:3000",
        );
        assert_eq!(find(&pass, "mode").as_deref(), Some("payment"));
        assert_eq!(
            find(&pass, "line_items[0][price_data][unit_amount]").as_deref(),
            Some("4900")
        );
        assert_eq!(
            find(&pass, "client_reference_id").as_deref(),
            Some(user.to_string().as_str())
        );
        assert!(find(&pass, "payment_intent_data[metadata][productId]").is_some());
        assert!(find(&pass, "subscription_data[metadata][productId]").is_none());
        assert_eq!(
            find(&pass, "success_url").as_deref(),
            Some("http://localhost:3000/app/billing?status=success")
        );

        let plan = checkout_params(
            catalog.get("pro-plan").unwrap(),
            user,
            "a@example.com",
            "https://app.example",
        );
        assert_eq!(find(&plan, "mode").as_deref(), Some("subscription"));
        assert_eq!(
            find(&plan, "line_items[0][price_data][recurring][interval]").as_deref(),
            Some("month")
        );
        assert!(find(&plan, "payment_intent_data[metadata][productId]").is_none());
        assert!(find(&plan, "subscription_data[metadata][productId]").is_some());
    }

    #[test]
    fn a_configured_price_id_replaces_inline_pricing() {
        let catalog = Catalog::parse(
            r#"{"products":[{"id":"pro-pass","name":"Pro","priceCents":4900,"currency":"usd","mode":"payment","stripePriceId":"price_123"}]}"#,
        )
        .unwrap();
        let params = checkout_params(
            catalog.get("pro-pass").unwrap(),
            Uuid::new_v4(),
            "a@example.com",
            "http://x",
        );
        assert!(
            params
                .iter()
                .any(|(key, value)| key == "line_items[0][price]" && value == "price_123")
        );
        assert!(!params.iter().any(|(key, _)| key.contains("price_data")));
    }

    #[test]
    fn client_keys_are_checked() {
        let mut headers = HeaderMap::new();
        assert_eq!(idempotency_key(&headers).unwrap().len(), 43);
        headers.insert("idempotency-key", "abc".parse().unwrap());
        assert!(idempotency_key(&headers).is_err());
        headers.insert("idempotency-key", "retry-key-12345".parse().unwrap());
        assert_eq!(idempotency_key(&headers).unwrap(), "retry-key-12345");
    }
}
