use kernel::{AppState, email::Email};
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn app_name(state: &AppState) -> String {
    state
        .config
        .email_from
        .split('<')
        .next()
        .unwrap_or("Invigil")
        .trim()
        .trim_matches('"')
        .to_owned()
}
pub fn code(state: &AppState, to: &str, code: &str) -> Email {
    let name = app_name(state);
    Email {
        to: to.into(),
        subject: format!("Your {name} code"),
        text: format!(
            "Your code: {code}\nThis code expires in 15 minutes. If you didn't ask for this, ignore it."
        ),
        html: format!(
            "<p>Your {} code:</p><p style=\"font-family:monospace;font-size:28px\">{code}</p><p>This code expires in 15 minutes. If you didn't ask for this, ignore it.</p>",
            escape(&name)
        ),
    }
}
pub fn notice(state: &AppState, to: &str) -> Email {
    let name = app_name(state);
    Email { to: to.into(), subject: format!("A {name} signup was attempted"), text: "Someone tried to create an account with your email. If it was you, sign in or reset your password.".into(), html: "<p>Someone tried to create an account with your email. If it was you, sign in or reset your password.</p>".into() }
}
pub fn send(state: &AppState, email: Email) {
    let sender = state.email.clone();
    tokio::spawn(async move {
        if let Err(err) = sender.send(&email).await {
            tracing::warn!(error = %err, "email delivery failed");
        }
    });
}
