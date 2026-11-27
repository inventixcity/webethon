//! Booking and calendar kit: bookable resources (rooms, tutors, tables, events with seats),
//! weekly hours, date exceptions, slots and bookings. See docs/BOOKING.md.

mod bookings;
mod clock;
mod cursor;
mod emails;
mod idempotency;
mod resources;
mod schedule;
mod store;
mod validate;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

use axum::{
    Router,
    routing::{get, post, put},
};
use kernel::AppState;

/// Mounted by the server at `/api/v1`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/booking/resources",
            get(resources::list).post(resources::create),
        )
        .route(
            "/booking/resources/{id}",
            get(resources::read)
                .patch(resources::update)
                .delete(resources::delete),
        )
        .route(
            "/booking/resources/{id}/availability",
            get(resources::availability).put(resources::set_rules),
        )
        .route(
            "/booking/resources/{id}/exceptions/{date}",
            put(resources::set_exception).delete(resources::delete_exception),
        )
        .route("/booking/resources/{id}/slots", get(resources::slots))
        .route(
            "/booking/resources/{id}/bookings",
            get(bookings::for_resource).post(bookings::create),
        )
        .route("/booking/bookings", get(bookings::mine))
        .route("/booking/bookings/{id}/cancel", post(bookings::cancel))
}
