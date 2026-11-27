//! exam_assist: see handoff/HANDOFF.md (PHASE 2) for the contract. Mounted under /api/v1.
use axum::Router;
use kernel::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
