//! Placeholder until the auth service is written.

use axum::Router;
use kernel::AppState;
use kernel::{
    config::Config,
    email::{Email, EmailSender, LogSender, SendFuture},
};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart, SinglePart},
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
    },
};
use secrecy::{ExposeSecret, SecretString};
use std::sync::Arc;

struct ResendSender {
    client: reqwest::Client,
    key: SecretString,
    from: String,
}

impl EmailSender for ResendSender {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            self.client.post("https://api.resend.com/emails")
                .bearer_auth(self.key.expose_secret())
                .json(&serde_json::json!({"from": self.from, "to": [email.to], "subject": email.subject, "html": email.html, "text": email.text}))
                .send().await?.error_for_status()?;
            Ok(())
        })
    }
}

struct SmtpSender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl EmailSender for SmtpSender {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            let message = Message::builder()
                .from(self.from.clone())
                .to(email.to.parse()?)
                .subject(&email.subject)
                .multipart(
                    MultiPart::alternative()
                        .singlepart(SinglePart::plain(email.text.clone()))
                        .singlepart(SinglePart::html(email.html.clone())),
                )?;
            self.transport.send(message).await?;
            Ok(())
        })
    }
}

/// Select the configured transactional email provider at startup.
pub fn email_sender(config: &Config) -> anyhow::Result<Arc<dyn EmailSender>> {
    if let Some(key) = &config.resend_api_key {
        return Ok(Arc::new(ResendSender {
            client: reqwest::Client::new(),
            key: key.clone(),
            from: config.email_from.clone(),
        }));
    }
    if let Some(raw) = &config.smtp_url {
        let url = reqwest::Url::parse(raw)?;
        anyhow::ensure!(url.scheme() == "smtp", "SMTP_URL must use smtp://");
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("SMTP_URL needs a host"))?;
        let tls = TlsParameters::new(host.to_owned())?;
        let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(url.port().unwrap_or(25))
            .tls(Tls::Opportunistic(tls));
        if !url.username().is_empty() {
            builder = builder.credentials(Credentials::new(
                url.username().to_owned(),
                url.password().unwrap_or_default().to_owned(),
            ));
        }
        return Ok(Arc::new(SmtpSender {
            transport: builder.build(),
            from: config.email_from.parse()?,
        }));
    }
    anyhow::ensure!(
        !config.is_production(),
        "An email provider is required in production"
    );
    Ok(Arc::new(LogSender))
}

pub fn router() -> Router<AppState> {
    routes::router()
}
mod codes;
mod emails;
mod mfa;
mod oauth;
mod password;
mod pending;
mod routes;
pub mod totp;
mod validate;

pub use mfa::admin_reauthenticate;
