//! Places on a map, map and radius searches, address lookup through a configured geocoder, and the
//! onboarding answers. Everything is mounted under `/api/v1` by the server crate.

mod geocode;
mod model;
mod onboarding;
mod places;
mod validate;

use std::sync::Arc;

use axum::{Extension, Router, routing::get};
use kernel::AppState;

use geocode::Geocoder;

/// Moderation hook for the admin crate: hides or restores a place for everyone except its owner.
pub use places::set_admin_hidden;

pub fn router() -> Router<AppState> {
    router_with(Geocoder::from_env())
}

/// Tests pass a geocoder that points at a mock server; production reads the environment.
fn router_with(geocoder: Option<Geocoder>) -> Router<AppState> {
    Router::new()
        .route("/places", get(places::list).post(places::create))
        .route("/places/nearby", get(places::nearby))
        .route("/places/geocode", get(geocode::search))
        .route(
            "/places/{id}",
            get(places::read)
                .patch(places::update)
                .delete(places::delete),
        )
        .route("/onboarding", get(onboarding::read).put(onboarding::save))
        .layer(Extension(Arc::new(geocoder)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
