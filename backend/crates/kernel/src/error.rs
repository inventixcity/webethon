//! One error shape for the whole API: `{ "error": { "code", "message", "details"?, "requestId" } }`.
//! Clients branch on `code`. Messages are written for people and never contain internals.

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::Value;

use crate::request::current_request_id;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BadRequest,
    ValidationFailed,
    Unauthenticated,
    InvalidCredentials,
    InvalidCode,
    EmailNotVerified,
    /// The password was right; a second factor is needed. `details.mfaToken` continues the sign-in.
    MfaRequired,
    Forbidden,
    AccountSuspended,
    CsrfRejected,
    NotFound,
    MethodNotAllowed,
    Conflict,
    VersionConflict,
    PreconditionRequired,
    IdempotencyMismatch,
    WeakPassword,
    LimitReached,
    PayloadTooLarge,
    UnsupportedMediaType,
    RateLimited,
    NotConfigured,
    Unavailable,
    Internal,
}

impl ErrorCode {
    pub fn status(self) -> StatusCode {
        use ErrorCode::*;
        match self {
            BadRequest | ValidationFailed => StatusCode::BAD_REQUEST,
            Unauthenticated | InvalidCredentials | InvalidCode => StatusCode::UNAUTHORIZED,
            EmailNotVerified | MfaRequired | Forbidden | AccountSuspended | CsrfRejected => {
                StatusCode::FORBIDDEN
            }
            NotFound => StatusCode::NOT_FOUND,
            MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Conflict | VersionConflict => StatusCode::CONFLICT,
            PreconditionRequired => StatusCode::PRECONDITION_REQUIRED,
            IdempotencyMismatch | WeakPassword | LimitReached => StatusCode::UNPROCESSABLE_ENTITY,
            PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            RateLimited => StatusCode::TOO_MANY_REQUESTS,
            NotConfigured | Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<Value>,
    /// Seconds, sent as Retry-After.
    pub retry_after: Option<u64>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: if code == ErrorCode::ValidationFailed {
                "Please check the highlighted fields.".to_owned()
            } else {
                message.into()
            },
            details: None,
            retry_after: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn retry_after(mut self, seconds: u64) -> Self {
        self.retry_after = Some(seconds);
        self
    }

    pub fn not_found() -> Self {
        Self::new(ErrorCode::NotFound, "We couldn't find that.")
    }

    pub fn unauthenticated() -> Self {
        Self::new(ErrorCode::Unauthenticated, "Please sign in to continue.")
    }

    pub fn forbidden() -> Self {
        Self::new(ErrorCode::Forbidden, "You don't have access to that.")
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    /// Logs the real cause server-side and returns a generic message to the client.
    pub fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!(request_id = %current_request_id(), error = %cause, "internal error");
        Self::new(
            ErrorCode::Internal,
            "Something went wrong on our side. Please try again.",
        )
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        match &error {
            sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => {
                tracing::error!(request_id = %current_request_id(), error = %error, "database unavailable");
                Self::new(
                    ErrorCode::Unavailable,
                    "The service is busy. Please try again in a moment.",
                )
                .retry_after(2)
            }
            _ => Self::internal(error),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(format!("{error:#}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Body<'a> {
    code: ErrorCode,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<&'a Value>,
    request_id: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Body {
            code: self.code,
            message: &self.message,
            details: self.details.as_ref(),
            request_id: current_request_id(),
        };
        let mut response = (
            self.code.status(),
            Json(serde_json::json!({ "error": body })),
        )
            .into_response();
        if let Some(seconds) = self.retry_after
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

/// Returns true when a database error is a unique-constraint violation.
pub fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(db) if db.code().as_deref() == Some("23505"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn validation_messages_are_canonical_and_details_preserved() {
        let details = serde_json::json!([{ "path": "email", "message": "Required." }]);
        for legacy in ["Please check your input.", "secret", ""] {
            let error =
                AppError::new(ErrorCode::ValidationFailed, legacy).with_details(details.clone());
            assert_eq!(error.message, "Please check the highlighted fields.");
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                body["error"]["message"],
                "Please check the highlighted fields."
            );
            assert_eq!(body["error"]["details"], details);
        }
        assert_eq!(AppError::bad_request("custom").message, "custom");
    }

    #[tokio::test]
    async fn pool_errors_are_retryable_and_do_not_expose_the_cause() {
        for error in [sqlx::Error::PoolClosed, sqlx::Error::PoolTimedOut] {
            let response = AppError::from(error).into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()[header::RETRY_AFTER], "2");
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["error"]["code"], "UNAVAILABLE");
            assert_eq!(
                body["error"]["message"],
                "The service is busy. Please try again in a moment."
            );
        }
    }
}
