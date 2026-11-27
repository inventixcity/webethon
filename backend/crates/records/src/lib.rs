pub mod api;
mod cursor;
mod defaults;
mod idempotency;
pub mod moderation;
pub mod query;
pub mod registry;
mod routes;
pub mod service;
pub use registry::{EntityRegistry, load_registry};
pub use routes::router;
mod account;
/// The signed-in user's own profile: GET, PATCH and DELETE /me.
pub fn account_router() -> axum::Router<kernel::AppState> {
    account::router()
}
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
