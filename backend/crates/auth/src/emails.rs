use kernel::{AppState, email::Email, email_layout};
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
        subject: email_layout::subject(&format!("Your {name} code")),
        text: format!(
            "Your code: {code}\nThis code expires in 15 minutes. If you didn't ask for this, ignore it."
        ),
        reply_to: None,
        html: email_layout::layout(
            "SECURITY / VERIFY EMAIL",
            "Your sign-in code",
            "Your one-time Invigil code",
            &format!(
                "<p style=\"font:15px/1.6 Helvetica,Arial,sans-serif;color:#12110E\">Use this one-time code to continue.</p>{}<p style=\"font:14px/1.6 Helvetica,Arial,sans-serif;color:#12110E\">If you did not request this, you can ignore this email.</p>",
                email_layout::code(code, "This code expires in 15 minutes.")
            ),
            "You requested a sign-in or verification code.",
        ),
    }
}
pub fn notice(state: &AppState, to: &str) -> Email {
    let name = app_name(state);
    let text = "Someone tried to create an account with your email. If it was you, sign in or reset your password.\n\nWe never ask for your password by email.";
    Email {
        to: to.into(),
        subject: email_layout::subject(&format!("A {name} signup was attempted")),
        text: text.into(),
        reply_to: None,
        html: email_layout::layout(
            "SECURITY / ACCOUNT NOTICE",
            "A signup was attempted",
            "Someone tried to create an account with your email",
            "<p style=\"font:15px/1.6 Helvetica,Arial,sans-serif;color:#12110E\">Someone tried to create an account with your email. If it was you, sign in or reset your password.</p>",
            "You received this notice because a signup was attempted with your email address.",
        ),
    }
}
pub fn send(state: &AppState, email: Email) {
    let sender = state.email.clone();
    tokio::spawn(async move {
        if let Err(err) = sender.send(&email).await {
            tracing::warn!(error = %err, "email delivery failed");
        }
    });
}
