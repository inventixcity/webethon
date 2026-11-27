//! The invite email. Team and inviter names are user-written, so everything is escaped for HTML and
//! stripped of control characters before it goes into a subject line.

use kernel::{config::Config, email::Email};

use crate::role::TeamRole;

pub struct Invite<'a> {
    pub to: &'a str,
    pub team_name: &'a str,
    pub inviter: &'a str,
    pub role: TeamRole,
    pub link: &'a str,
}

/// The link opens the join page, which reads the token and posts it to the API. The token is in the
/// URL only, never in logs or the response body.
pub fn join_link(config: &Config, token: &str) -> String {
    format!("{}/app/teams/join?token={token}", config.app_origin)
}

/// The brand name from the sender address, such as "Invigil" for "Invigil <hi@example.com>".
pub fn app_name(config: &Config) -> String {
    let name = config
        .email_from
        .split('<')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .trim();
    if name.is_empty() {
        "Invigil".to_owned()
    } else {
        plain(name, 80)
    }
}

/// Drops control characters and caps the length, for text that goes into a subject or a sentence.
fn plain(value: &str, max: usize) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect();
    cleaned.trim().to_owned()
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn role_label(role: TeamRole) -> &'static str {
    match role {
        TeamRole::Admin => "an admin",
        TeamRole::Member => "a member",
        TeamRole::Viewer => "a viewer",
        TeamRole::Owner => "an owner",
    }
}

pub fn invite(app: &str, invite: &Invite<'_>) -> Email {
    let team = plain(invite.team_name, 80);
    let inviter = match plain(invite.inviter, 120) {
        name if name.is_empty() => "Someone".to_owned(),
        name => name,
    };
    let role = role_label(invite.role);
    let expiry = "This link works once and expires in 7 days.";
    let ignore = "If you weren't expecting this, you can ignore this email.";
    Email {
        to: invite.to.to_owned(),
        subject: format!("Join {team} on {app}"),
        text: format!(
            "{inviter} invited you to join {team} as {role}.\n\nOpen this link and sign in with {to} to accept:\n{link}\n\n{expiry}\n{ignore}",
            to = invite.to,
            link = invite.link,
        ),
        html: format!(
            "<p>{inviter} invited you to join <strong>{team}</strong> as {role}.</p>\
             <p>Open this link and sign in with {to} to accept:</p>\
             <p><a href=\"{link}\">Join {team}</a></p>\
             <p>{expiry}<br>{ignore}</p>",
            inviter = escape(&inviter),
            team = escape(&team),
            role = role,
            to = escape(invite.to),
            link = escape(invite.link),
            expiry = expiry,
            ignore = ignore,
        ),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn user_text_is_escaped_in_html_and_kept_out_of_subjects() {
        let email = invite(
            "Invigil",
            &Invite {
                to: "ann@example.com",
                team_name: "<img src=x onerror=alert(1)>\n",
                inviter: "\"Eve\" <script>",
                role: TeamRole::Member,
                link: "https://app.example.com/app/teams/join?token=abc",
            },
        );
        assert!(!email.html.contains("<script>"));
        assert!(!email.html.contains("<img"));
        assert!(email.html.contains("&lt;script&gt;"));
        assert!(!email.subject.contains('\n'));
        assert!(email.text.contains("token=abc"));
    }

    #[test]
    fn missing_inviter_name_has_a_fallback() {
        let email = invite(
            "Invigil",
            &Invite {
                to: "ann@example.com",
                team_name: "Night Owls",
                inviter: "\u{7}",
                role: TeamRole::Viewer,
                link: "https://x.test/j",
            },
        );
        assert!(email.text.starts_with("Someone invited you"));
    }
}
