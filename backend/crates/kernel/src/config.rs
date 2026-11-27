//! Every setting, read once from the environment. Production refuses to start half-configured.

use std::{
    collections::{BTreeMap, HashSet},
    env,
    net::SocketAddr,
    time::Duration,
};

use anyhow::{Context, bail};
use secrecy::{ExposeSecret, SecretString};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Development,
    Production,
}

#[derive(Clone, Debug)]
pub struct OAuthClient {
    pub client_id: String,
    pub client_secret: SecretString,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub environment: Environment,
    pub bind: SocketAddr,
    pub metrics_bind: SocketAddr,
    pub database_url: SecretString,
    /// The public web origin, such as https://myapp.vercel.app. OAuth redirects and email links use it.
    pub app_origin: String,
    /// Origins allowed to send cookie-authenticated writes (CSRF). Always includes `app_origin`.
    pub allowed_origins: HashSet<String>,
    /// Shared with the Next.js proxy, which signs the visitor's IP with it.
    pub proxy_secret: Option<SecretString>,
    /// How many reverse proxies in front of the API may be trusted in X-Forwarded-For.
    pub trusted_proxy_hops: usize,
    /// Keyed hash for email codes, so a database dump doesn't reveal live codes.
    pub code_pepper: SecretString,
    pub code_pepper_id: String,
    pub code_pepper_keys: BTreeMap<String, SecretString>,
    pub ip_rate_limit_scale: u32,
    pub anonymous_sse_per_ip: usize,
    pub db_max_connections: u32,
    pub session_cookie: String,
    pub session_ttl: Duration,
    pub secure_cookies: bool,
    pub email_from: String,
    pub resend_api_key: Option<SecretString>,
    /// For development, e.g. smtp://mailpit:1025.
    pub smtp_url: Option<String>,
    pub admin_emails: HashSet<String>,
    pub google: Option<OAuthClient>,
    pub github: Option<OAuthClient>,
    pub demo_email: Option<String>,
    pub demo_password: Option<SecretString>,
    pub breach_check: bool,
    pub entities_path: String,
    pub max_body_bytes: usize,
    pub request_timeout: Duration,
}

fn var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn secret(name: &str) -> Option<SecretString> {
    var(name).map(SecretString::from)
}

fn parse<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    match var(name) {
        Some(raw) => raw
            .parse()
            .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}")),
        None => Ok(default),
    }
}

fn valid_pepper_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn pepper_keys(
    id: &str,
    raw: Option<&str>,
    production: bool,
) -> anyhow::Result<BTreeMap<String, SecretString>> {
    if !valid_pepper_id(id) {
        bail!("CODE_PEPPER_ID is invalid");
    }
    let keys: BTreeMap<String, String> = match raw {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| anyhow::anyhow!("CODE_PEPPER_KEYS must be a JSON object of strings"))?,
        None => BTreeMap::new(),
    };
    if keys.len() > 4 || keys.keys().any(|key| !valid_pepper_id(key) || key == id) {
        bail!("CODE_PEPPER_KEYS contains invalid or duplicate IDs");
    }
    if production && keys.values().any(|key| key.len() < 32) {
        bail!("CODE_PEPPER_KEYS values must be at least 32 characters in production");
    }
    Ok(keys
        .into_iter()
        .map(|(key, value)| (key, SecretString::from(value)))
        .collect())
}

fn bounded<T: std::str::FromStr + PartialOrd>(
    name: &str,
    default: T,
    min: T,
    max: T,
) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    bounded_value(name, var(name).as_deref(), default, min, max)
}

fn bounded_value<T: std::str::FromStr + PartialOrd>(
    name: &str,
    raw: Option<&str>,
    default: T,
    min: T,
    max: T,
) -> anyhow::Result<T> {
    let value = match raw {
        Some(raw) => raw
            .parse()
            .map_err(|_| anyhow::anyhow!("{name} is invalid"))?,
        None => default,
    };
    if value < min || value > max {
        bail!("{name} is out of range");
    }
    Ok(value)
}

fn validate_demo_admin(demo: &Option<String>, admins: &HashSet<String>) -> anyhow::Result<()> {
    if demo.as_ref().is_some_and(|email| admins.contains(email)) {
        bail!("DEMO_EMAIL must not be in ADMIN_EMAILS");
    }
    Ok(())
}

fn oauth(prefix: &str) -> Option<OAuthClient> {
    Some(OAuthClient {
        client_id: var(&format!("{prefix}_CLIENT_ID"))?,
        client_secret: secret(&format!("{prefix}_CLIENT_SECRET"))?,
    })
}

fn origin(raw: &str) -> anyhow::Result<String> {
    let trimmed = raw.trim_end_matches('/');
    let valid = (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && !trimmed[8..].contains('/')
        && !trimmed.contains(['?', '#', '@', ' ']);
    if !valid {
        bail!("{raw:?} is not an origin like https://example.com");
    }
    Ok(trimmed.to_ascii_lowercase())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let environment = match var("APP_ENV").as_deref() {
            Some("production") => Environment::Production,
            Some("development") | None => Environment::Development,
            Some(other) => bail!("APP_ENV must be development or production, not {other:?}"),
        };
        let production = environment == Environment::Production;

        let app_origin =
            origin(&var("APP_ORIGIN").unwrap_or_else(|| "http://localhost:3000".into()))?;
        let mut allowed_origins = HashSet::from([app_origin.clone()]);
        for extra in var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|value| !value.trim().is_empty())
        {
            allowed_origins.insert(origin(extra.trim())?);
        }

        let code_pepper = match secret("CODE_PEPPER") {
            Some(value) => value,
            None if !production => {
                tracing::warn!("CODE_PEPPER is not set; using a development-only value");
                SecretString::from("development-only-pepper-change-me-0000000000")
            }
            None => bail!("CODE_PEPPER is required in production"),
        };

        let code_pepper_id = var("CODE_PEPPER_ID").unwrap_or_else(|| "v1".into());
        let code_pepper_keys = pepper_keys(
            &code_pepper_id,
            var("CODE_PEPPER_KEYS").as_deref(),
            production,
        )?;

        let config = Self {
            environment,
            bind: parse("BIND_ADDR", SocketAddr::from(([0, 0, 0, 0], 8080)))?,
            metrics_bind: parse("METRICS_ADDR", SocketAddr::from(([0, 0, 0, 0], 9090)))?,
            database_url: secret("DATABASE_URL").context("DATABASE_URL is required")?,
            app_origin,
            allowed_origins,
            proxy_secret: secret("PROXY_SECRET"),
            trusted_proxy_hops: parse("TRUSTED_PROXY_HOPS", 0usize)?,
            code_pepper,
            code_pepper_id,
            code_pepper_keys,
            ip_rate_limit_scale: bounded("IP_RATE_LIMIT_SCALE", 1u32, 1, 100)?,
            anonymous_sse_per_ip: bounded("ANON_SSE_PER_IP", 5usize, 1, 100)?,
            db_max_connections: bounded("DATABASE_MAX_CONNECTIONS", 10u32, 6, 64)?,
            session_cookie: var("SESSION_COOKIE").unwrap_or_else(|| {
                if production {
                    "__Host-session".into()
                } else {
                    "session".into()
                }
            }),
            session_ttl: Duration::from_secs(parse("SESSION_TTL_DAYS", 30u64)? * 86_400),
            secure_cookies: parse("SECURE_COOKIES", production)?,
            email_from: var("EMAIL_FROM")
                .unwrap_or_else(|| "Inventix Invigil <onboarding@resend.dev>".into()),
            resend_api_key: secret("RESEND_API_KEY"),
            smtp_url: var("SMTP_URL"),
            admin_emails: var("ADMIN_EMAILS")
                .unwrap_or_default()
                .split(',')
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .collect(),
            google: oauth("GOOGLE"),
            github: oauth("GITHUB"),
            demo_email: var("DEMO_EMAIL").map(|value| value.to_ascii_lowercase()),
            demo_password: secret("DEMO_PASSWORD"),
            breach_check: parse("BREACH_CHECK", true)?,
            entities_path: var("ENTITIES_PATH").unwrap_or_else(|| "config/entities.json".into()),
            max_body_bytes: parse("MAX_BODY_BYTES", 1_048_576usize)?,
            request_timeout: Duration::from_secs(parse("REQUEST_TIMEOUT_SECS", 15u64)?),
        };
        validate_demo_admin(&config.demo_email, &config.admin_emails)?;
        config.check_production_posture()?;
        Ok(config)
    }

    pub fn code_pepper_for(&self, id: &str) -> Option<&SecretString> {
        if id == self.code_pepper_id {
            Some(&self.code_pepper)
        } else {
            self.code_pepper_keys.get(id)
        }
    }

    /// Scale only budgets explicitly chosen by the caller for IP addresses.
    pub fn scaled_ip_limit(&self, budget: crate::security::Limit) -> crate::security::Limit {
        crate::security::Limit {
            limit: budget
                .limit
                .saturating_mul(i32::try_from(self.ip_rate_limit_scale).unwrap_or(i32::MAX)),
            ..budget
        }
    }

    pub fn is_production(&self) -> bool {
        self.environment == Environment::Production
    }

    /// Refuses unsafe combinations instead of running with them.
    fn check_production_posture(&self) -> anyhow::Result<()> {
        if !self.is_production() {
            return Ok(());
        }
        if !self.app_origin.starts_with("https://") {
            bail!("APP_ORIGIN must be https in production");
        }
        if !self.secure_cookies {
            bail!("SECURE_COOKIES can't be false in production");
        }
        if self.code_pepper.expose_secret().len() < 32 {
            bail!("CODE_PEPPER must be at least 32 characters");
        }
        match &self.proxy_secret {
            Some(value) if value.expose_secret().len() >= 32 => {}
            _ => bail!("PROXY_SECRET (32+ characters) is required in production"),
        }
        if self.resend_api_key.is_none() && self.smtp_url.is_none() {
            bail!("Set RESEND_API_KEY (or SMTP_URL) so verification emails can be sent");
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            environment: Environment::Development,
            bind: ([127, 0, 0, 1], 80).into(),
            metrics_bind: ([127, 0, 0, 1], 81).into(),
            database_url: SecretString::from("db-secret"),
            app_origin: "http://localhost".into(),
            allowed_origins: HashSet::new(),
            proxy_secret: None,
            trusted_proxy_hops: 0,
            code_pepper: SecretString::from("current-secret"),
            code_pepper_id: "v1".into(),
            code_pepper_keys: pepper_keys("v1", Some(r#"{"old":"old-secret"}"#), false).unwrap(),
            ip_rate_limit_scale: 100,
            anonymous_sse_per_ip: 5,
            db_max_connections: 10,
            session_cookie: "session".into(),
            session_ttl: Duration::from_secs(1),
            secure_cookies: false,
            email_from: String::new(),
            resend_api_key: None,
            smtp_url: None,
            admin_emails: HashSet::new(),
            google: None,
            github: None,
            demo_email: None,
            demo_password: None,
            breach_check: false,
            entities_path: String::new(),
            max_body_bytes: 1,
            request_timeout: Duration::from_secs(1),
        }
    }
    #[test]
    fn lookup_scaling_and_admin_exclusion() {
        let config = config();
        assert_eq!(
            config.code_pepper_for("v1").unwrap().expose_secret(),
            "current-secret"
        );
        assert_eq!(
            config.code_pepper_for("old").unwrap().expose_secret(),
            "old-secret"
        );
        assert!(config.code_pepper_for("missing").is_none());
        let debug = format!("{config:?}");
        assert!(
            !debug.contains("current-secret")
                && !debug.contains("old-secret")
                && !debug.contains("db-secret")
        );
        let ip = crate::security::limits::SIGN_IN_PER_IP;
        assert_eq!(config.scaled_ip_limit(ip).limit, ip.limit * 100);
        assert_eq!(config.scaled_ip_limit(ip).window, ip.window);
        let account = crate::security::limits::SIGN_IN_PER_ACCOUNT;
        assert_eq!(account.limit, 8);
        assert_eq!(
            config
                .scaled_ip_limit(crate::security::Limit {
                    limit: i32::MAX,
                    window: ip.window
                })
                .limit,
            i32::MAX
        );
        let admins = HashSet::from(["demo@example.com".to_owned()]);
        assert!(validate_demo_admin(&Some("demo@example.com".into()), &admins).is_err());
        assert!(validate_demo_admin(&None, &admins).is_ok());
    }
    #[test]
    fn keyring_validates_and_hides_secrets() {
        let keys = pepper_keys("v1", Some(r#"{"old":"a secret value"}"#), false).unwrap();
        assert_eq!(keys["old"].expose_secret(), "a secret value");
        assert!(!format!("{keys:?}").contains("a secret value"));
        for raw in [
            r#"{"v1":"secret"}"#,
            r#"{"bad id":"secret"}"#,
            r#"{"a":"1","b":"2","c":"3","d":"4","e":"5"}"#,
            "not json",
            r#"{"a":12}"#,
        ] {
            let error = pepper_keys("v1", Some(raw), true).unwrap_err().to_string();
            assert!(!error.contains("secret"));
        }
        assert!(pepper_keys("", None, false).is_err());
        assert!(pepper_keys("?", None, false).is_err());
        assert!(pepper_keys("v1", Some(r#"{"old":"short"}"#), true).is_err());
        assert!(
            pepper_keys(
                "v1",
                Some(&format!(r#"{{"old":"{}"}}"#, "x".repeat(32))),
                true
            )
            .is_ok()
        );
    }
    #[test]
    fn bounded_values_reject_invalid_ranges() {
        assert_eq!(bounded_value("test", None, 5u32, 1, 100).unwrap(), 5);
        for raw in ["0", "101", "-1", "bad"] {
            assert!(bounded_value("test", Some(raw), 5u32, 1, 100).is_err());
        }
        assert!(bounded_value("test", Some("6"), 10u32, 6, 64).is_ok());
        assert!(bounded_value("test", Some("65"), 10u32, 6, 64).is_err());
    }
}
