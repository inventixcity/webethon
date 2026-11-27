use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::{config::Config, email::EmailSender};

/// Shared by every handler. Cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
    pub email: Arc<dyn EmailSender>,
    /// Caps parallel password hashing (each Argon2 run takes ~19 MiB), so a burst of sign-ins
    /// can't exhaust memory.
    pub hashing: Arc<Semaphore>,
}
