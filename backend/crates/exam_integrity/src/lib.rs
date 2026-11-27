//! exam_integrity: see handoff/HANDOFF.md for the contract this crate implements. Mount `router()` under `/api/v1`.
use axum::Router;
use kernel::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
