//! Stripe settings and the product catalog, read once at startup.
//!
//! Anything wrong with payment settings turns payments off (NOT_CONFIGURED) and logs why. It never
//! stops the API, because the rest of the app doesn't depend on it.

use kernel::{AppError, ErrorCode};
use secrecy::SecretString;

use crate::catalog::Catalog;

/// The answer whenever payments are off, whichever setting is missing.
pub(crate) fn not_configured() -> AppError {
    AppError::new(ErrorCode::NotConfigured, "Payments aren't set up yet.")
}

/// Settings for one Stripe account. Only ever built from a validated secret key.
#[derive(Clone)]
pub struct StripeConfig {
    pub secret_key: SecretString,
    /// Needed to verify webhooks. Without it checkout still works, but webhooks are refused.
    pub webhook_secret: Option<SecretString>,
    /// Without a trailing slash. Plain http is only accepted for loopback (tests and local mocks).
    pub api_base: String,
    /// True for sk_live_ keys. Only accepted when STRIPE_ALLOW_LIVE=true.
    pub live: bool,
}

/// Everything the payments routes need, shared behind an Arc.
pub struct Settings {
    /// None means payments are off.
    pub stripe: Option<StripeConfig>,
    pub catalog: Catalog,
}

const DEFAULT_API_BASE: &str = "https://api.stripe.com";
const DEFAULT_PRODUCTS_PATH: &str = "config/products.json";

impl StripeConfig {
    /// Checks the raw values. Pure, so the rules can be tested without touching the environment.
    pub fn from_values(
        secret_key: Option<&str>,
        webhook_secret: Option<&str>,
        api_base: Option<&str>,
        allow_live: bool,
    ) -> Result<Option<Self>, String> {
        let Some(key) = secret_key.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let live = if key.starts_with("sk_test_") {
            false
        } else if key.starts_with("sk_live_") {
            if !allow_live {
                return Err(
                    "STRIPE_SECRET_KEY is a live key. Set STRIPE_ALLOW_LIVE=true only for real payments."
                        .into(),
                );
            }
            true
        } else {
            return Err("STRIPE_SECRET_KEY must be a secret key starting with sk_test_.".into());
        };
        if key.len() > 256 || key.bytes().any(|byte| byte.is_ascii_whitespace()) {
            return Err("STRIPE_SECRET_KEY is malformed.".into());
        }
        let base = api_base
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_API_BASE)
            .trim_end_matches('/')
            .to_owned();
        if !valid_api_base(&base) {
            return Err("STRIPE_API_BASE must be https, or http on a loopback address.".into());
        }
        let webhook_secret = webhook_secret
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| SecretString::from(value.to_owned()));
        Ok(Some(Self {
            secret_key: SecretString::from(key.to_owned()),
            webhook_secret,
            api_base: base,
            live,
        }))
    }

    fn from_env() -> Result<Option<Self>, String> {
        Self::from_values(
            var("STRIPE_SECRET_KEY").as_deref(),
            var("STRIPE_WEBHOOK_SECRET").as_deref(),
            var("STRIPE_API_BASE").as_deref(),
            var("STRIPE_ALLOW_LIVE").as_deref() == Some("true"),
        )
    }
}

fn valid_api_base(base: &str) -> bool {
    let Ok(url) = url::Url::parse(base) else {
        return false;
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match url.scheme() {
        "https" => true,
        // The key is sent with every request, so plain http is only allowed to this machine.
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
        _ => false,
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl Settings {
    /// Reads the environment. Problems are logged and switch the affected part off.
    pub fn from_env() -> Self {
        let stripe = match StripeConfig::from_env() {
            Ok(stripe) => {
                if stripe.is_none() {
                    tracing::info!("Stripe isn't configured; payments are off");
                }
                stripe
            }
            Err(reason) => {
                tracing::error!(reason = %reason, "Stripe settings refused; payments are off");
                None
            }
        };
        let path = var("PRODUCTS_PATH").unwrap_or_else(|| DEFAULT_PRODUCTS_PATH.into());
        Self {
            stripe,
            catalog: Catalog::load(&path),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_means_not_configured() {
        assert!(
            StripeConfig::from_values(None, None, None, false)
                .unwrap()
                .is_none()
        );
        assert!(
            StripeConfig::from_values(Some("  "), None, None, false)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn test_keys_are_accepted() {
        let config = StripeConfig::from_values(Some("sk_test_abc"), Some("whsec_x"), None, false)
            .unwrap()
            .unwrap();
        assert!(!config.live);
        assert_eq!(config.api_base, "https://api.stripe.com");
        assert!(config.webhook_secret.is_some());
    }

    #[test]
    fn live_keys_are_refused_unless_explicitly_allowed() {
        assert!(StripeConfig::from_values(Some("sk_live_abc"), None, None, false).is_err());
        let config = StripeConfig::from_values(Some("sk_live_abc"), None, None, true)
            .unwrap()
            .unwrap();
        assert!(config.live);
    }

    #[test]
    fn publishable_and_other_keys_are_refused() {
        assert!(StripeConfig::from_values(Some("pk_test_abc"), None, None, false).is_err());
        assert!(StripeConfig::from_values(Some("rk_test_abc"), None, None, false).is_err());
        assert!(StripeConfig::from_values(Some("sk_test_a b"), None, None, false).is_err());
    }

    #[test]
    fn plain_http_only_for_loopback() {
        assert!(
            StripeConfig::from_values(Some("sk_test_a"), None, Some("http://evil.example"), false)
                .is_err()
        );
        assert!(
            StripeConfig::from_values(
                Some("sk_test_a"),
                None,
                Some("https://evil.example/"),
                false
            )
            .is_ok()
        );
        let local = StripeConfig::from_values(
            Some("sk_test_a"),
            None,
            Some("http://127.0.0.1:4010/"),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(local.api_base, "http://127.0.0.1:4010");
        assert!(
            StripeConfig::from_values(
                Some("sk_test_a"),
                None,
                Some("https://user@evil.example"),
                false
            )
            .is_err()
        );
    }
}
