//! A small client for Stripe's REST API: form-encoded requests, one short timeout, and logs that
//! never include response bodies (Stripe error text can echo customer details).

use std::time::Duration;

use kernel::{AppError, ErrorCode};
use secrecy::ExposeSecret;
use serde_json::Value;

use crate::config::StripeConfig;

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Stripe answered 404: the object doesn't exist (in this mode).
    NotFound,
    /// Network trouble, a timeout, a 5xx, or an answer we can't read.
    Unavailable,
}

impl Failure {
    pub fn into_app(self) -> AppError {
        AppError::new(
            ErrorCode::Unavailable,
            "Payments are unavailable right now. Please try again in a moment.",
        )
        .retry_after(5)
    }
}

pub type Reply = Result<Value, Failure>;

pub struct Stripe<'a> {
    pub http: &'a reqwest::Client,
    pub config: &'a StripeConfig,
}

impl Stripe<'_> {
    pub async fn get(&self, path: &str) -> Reply {
        self.send(reqwest::Method::GET, path, None, None).await
    }

    pub async fn post(
        &self,
        path: &str,
        params: &[(String, String)],
        idempotency_key: Option<&str>,
    ) -> Reply {
        self.send(reqwest::Method::POST, path, Some(params), idempotency_key)
            .await
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        params: Option<&[(String, String)]>,
        idempotency_key: Option<&str>,
    ) -> Reply {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.config.api_base))
            .bearer_auth(self.config.secret_key.expose_secret())
            .header("accept", "application/json")
            .timeout(TIMEOUT);
        if let Some(params) = params {
            request = request
                .header("content-type", "application/x-www-form-urlencoded")
                .body(encode(params));
        }
        if let Some(key) = idempotency_key {
            request = request.header("idempotency-key", key);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                tracing::error!(path, timeout = error.is_timeout(), "Stripe request failed");
                return Err(Failure::Unavailable);
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            // Stripe's error type and code are safe to log. The message is not.
            let parsed: Option<Value> = serde_json::from_str(&text).ok();
            let kind = parsed
                .as_ref()
                .and_then(|value| value.pointer("/error/type"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let code = parsed
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(Value::as_str)
                .unwrap_or("none");
            tracing::error!(
                path,
                status = status.as_u16(),
                kind,
                code,
                "Stripe refused a request"
            );
            return Err(if status == reqwest::StatusCode::NOT_FOUND {
                Failure::NotFound
            } else {
                Failure::Unavailable
            });
        }
        serde_json::from_str(&text).map_err(|_| Failure::Unavailable)
    }
}

/// Stripe wants `a[b][c]=value` keys, which every form encoder percent-encodes. Pairs keep their order.
pub fn encode(params: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

/// Stripe object ids are letters, digits and underscores. Anything else never reaches a URL path.
pub fn valid_id(id: &str) -> bool {
    (1..=255).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_encoded_and_values_escaped() {
        let body = encode(&[
            ("metadata[productId]".into(), "pro pass&x".into()),
            ("line_items[0][quantity]".into(), "1".into()),
        ]);
        assert_eq!(
            body,
            "metadata%5BproductId%5D=pro+pass%26x&line_items%5B0%5D%5Bquantity%5D=1"
        );
        let decoded: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            decoded[0],
            ("metadata[productId]".into(), "pro pass&x".into())
        );
    }

    #[test]
    fn ids_are_restricted_to_safe_characters() {
        assert!(valid_id("cs_test_a1B2"));
        assert!(!valid_id("cs_1/../../admin"));
        assert!(!valid_id("sub 1"));
        assert!(!valid_id(""));
    }
}
