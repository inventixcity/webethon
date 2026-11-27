use kernel::{AppError, AppResult, ErrorCode};
use secrecy::SecretString;
use std::{
    collections::HashSet,
    env,
    sync::{Arc, OnceLock},
    time::Duration,
};

pub struct AiConfig {
    pub base: String,
    pub key: Option<SecretString>,
    pub model: String,
    pub embedding_model: Option<String>,
    pub allowed: HashSet<String>,
    pub system: String,
    pub max_output: i64,
    pub daily: i64,
    pub timeout: Duration,
    pub valid: bool,
}
fn var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
impl AiConfig {
    fn from_env() -> Self {
        let mut valid = true;
        let mut number = |name: &str, default: i64| match var(name) {
            None => default,
            Some(value) => match value.parse::<i64>() {
                Ok(value) if value > 0 => value,
                _ => {
                    valid = false;
                    tracing::error!(setting = name, "invalid AI setting");
                    default
                }
            },
        };
        let max_output = number("AI_MAX_OUTPUT_TOKENS", 1024).min(4096);
        let daily = number("AI_DAILY_TOKENS_PER_USER", 200000).min(i64::MAX / 4);
        let timeout = Duration::from_secs(number("AI_TIMEOUT_SECS", 60).min(3600) as u64);
        let base = var("AI_BASE_URL").unwrap_or_else(|| "https://ai-gateway.vercel.sh/v1".into());
        let valid_url = reqwest::Url::parse(&base).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        });
        Self {
            base,
            key: var("AI_API_KEY").map(SecretString::from),
            model: var("AI_MODEL").unwrap_or_default(),
            embedding_model: var("AI_EMBEDDING_MODEL"),
            allowed: var("AI_MODELS_ALLOWED")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect(),
            system: var("AI_SYSTEM_PROMPT")
                .unwrap_or_else(|| "You are a helpful assistant.".into()),
            max_output,
            daily,
            timeout,
            valid: valid && valid_url,
        }
    }
    pub fn ready(&self) -> AppResult<()> {
        if !self.valid
            || self.key.is_none()
            || self.model.is_empty()
            || self.model.len() > 256
            || self.system.len() > 192000
        {
            return Err(AppError::new(
                ErrorCode::NotConfigured,
                "AI isn't configured yet.",
            ));
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn test(base: String) -> Self {
        Self {
            base,
            key: Some(SecretString::from("test-key")),
            model: "test/model".into(),
            embedding_model: None,
            allowed: HashSet::new(),
            system: "Server instructions".into(),
            max_output: 30,
            daily: 200000,
            timeout: Duration::from_secs(3),
            valid: true,
        }
    }
}
pub fn global() -> Arc<AiConfig> {
    static CONFIG: OnceLock<Arc<AiConfig>> = OnceLock::new();
    Arc::clone(CONFIG.get_or_init(|| Arc::new(AiConfig::from_env())))
}
