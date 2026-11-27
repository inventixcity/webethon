//! Stripe payments: Checkout, a signed webhook, entitlements and the customer portal.
//!
//! Stripe is the source of truth for money. Our tables hold what Stripe confirmed, and the webhook
//! re-reads every object from Stripe before anything changes.

mod catalog;
mod config;
mod routes;
mod signature;
mod store;
mod stripe;
mod webhook;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

pub use catalog::Catalog;
pub use store::has_entitlement;

use std::sync::Arc;

use axum::{
    Extension, Router,
    routing::{get, post},
};
use kernel::AppState;

/// Mounted by the server under `/api/v1`. Reads the environment once; never fails.
pub fn router() -> Router<AppState> {
    build(config::Settings::from_env())
}

fn build(settings: config::Settings) -> Router<AppState> {
    Router::new()
        .route("/billing/products", get(routes::products))
        .route("/billing/checkout", post(routes::checkout))
        .route("/billing/me", get(routes::me))
        .route("/billing/portal", post(routes::portal))
        // Stripe sends no cookie, so the server's cookie CSRF check doesn't apply. The signature is the check.
        .route("/billing/webhook", post(webhook::receive))
        .layer(Extension(Arc::new(settings)))
}
