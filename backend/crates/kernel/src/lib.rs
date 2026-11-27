//! Shared building blocks every service crate uses. Nothing here knows about a specific feature.

pub mod config;
pub mod crypto;
pub mod email;
pub mod email_layout;
pub mod error;
pub mod extract;
pub mod request;
pub mod security;
pub mod session;
pub mod state;
pub mod telemetry;
pub mod viewer;

pub use error::{AppError, AppResult, ErrorCode};
pub use state::AppState;
pub use viewer::{MaybeViewer, Viewer};
