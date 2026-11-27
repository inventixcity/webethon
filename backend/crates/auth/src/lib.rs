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
                .json(&{
                    let mut body = serde_json::json!({"from": self.from, "to": [email.to], "subject": email.subject, "html": email.html, "text": email.text});
                    if let Some(reply_to) = &email.reply_to {
                        body["reply_to"] = serde_json::json!([reply_to]);
                    }
                    body
                })
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
            let mut builder = Message::builder()
                .from(self.from.clone())
                .to(email.to.parse()?);
            if let Some(reply_to) = &email.reply_to {
                builder = builder.reply_to(reply_to.parse()?);
            }
            let message = builder.subject(&email.subject).multipart(
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
            .tls(Tls::Required(tls));
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

/// The auth router with self-signup, demo sign-in and OAuth enabled (tests, and institutions that opt in).
pub fn router_with_self_service() -> Router<AppState> {
    routes::router_with(true)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod smtp_tests {
    use super::*;
    use kernel::email::Email;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
        time::{Duration, timeout},
    };

    #[tokio::test]
    async fn smtp_without_starttls_never_receives_message_content() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local SMTP test server");
        let address = listener.local_addr().expect("read SMTP address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept SMTP connection");
            let (read, mut write) = stream.into_split();
            let mut read = BufReader::new(read);
            write
                .write_all(b"220 local.test ESMTP\r\n")
                .await
                .expect("send SMTP greeting");
            let mut line = String::new();
            timeout(Duration::from_secs(3), read.read_line(&mut line))
                .await
                .expect("wait for EHLO")
                .expect("read EHLO");
            assert!(line.starts_with("EHLO "));
            write
                .write_all(b"250-local.test\r\n250 SIZE 100000\r\n")
                .await
                .expect("advertise SMTP without STARTTLS");
            line.clear();
            let read_result = timeout(Duration::from_secs(3), read.read_line(&mut line)).await;
            (read_result, line)
        });

        let mut config = Config::from_env().expect("test config");
        config.resend_api_key = None;
        config.smtp_url = Some(format!("smtp://{address}"));
        config.email_from = "Inventix Invigil <sender@example.test>".into();
        let sender = email_sender(&config).expect("required-TLS SMTP sender");
        let result = sender
            .send(&Email {
                to: "candidate@example.test".into(),
                subject: "Sensitive reset code".into(),
                html: "Sensitive reset code".into(),
                text: "Sensitive reset code".into(),
                reply_to: None,
            })
            .await;
        assert!(result.is_err(), "SMTP without STARTTLS must fail closed");
        let (_, line) = server.await.expect("SMTP server task");
        assert!(
            !line.to_ascii_uppercase().starts_with("MAIL FROM"),
            "message content must not be sent before TLS"
        );
    }
}
mod codes;
mod emails;
mod mfa;
mod oauth;
pub mod password;
mod pending;
mod routes;
pub mod totp;
mod validate;

pub use mfa::admin_reauthenticate;
pub async fn request_password_reset(
    state: &AppState,
    meta: &kernel::request::RequestMeta,
    email: &str,
) -> kernel::AppResult<()> {
    routes::request_password_reset(state, meta, email).await
}
