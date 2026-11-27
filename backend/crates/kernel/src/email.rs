//! The email contract. The auth crate provides the Resend and SMTP senders.

use std::{future::Future, pin::Pin};

#[derive(Clone, Debug)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub html: String,
    pub text: String,
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

pub trait EmailSender: Send + Sync + 'static {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a>;
}

/// Prints emails to the log instead of sending them. Development only.
pub struct LogSender;

impl EmailSender for LogSender {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            tracing::info!(to = %email.to, subject = %email.subject, body = %email.text, "email (not sent: development log sender)");
            Ok(())
        })
    }
}
