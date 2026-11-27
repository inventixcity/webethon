//! Input checks for request bodies and path ids. Failures use VALIDATION_FAILED with a `path` per
//! field, and a bad id in the path is a plain 404, because it can't name a team anyway.

use kernel::{AppError, AppResult, ErrorCode, crypto};
use serde_json::json;
use uuid::Uuid;

use crate::role::TeamRole;

pub fn failure(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path, "message": message }]))
}

/// Trims the name and requires 1 to 80 characters with no control characters (line breaks would
/// break layouts and log lines).
pub fn team_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let length = name.chars().count();
    if !(1..=80).contains(&length) {
        return Err(failure("name", "Use between 1 and 80 characters."));
    }
    if name.chars().any(char::is_control) {
        return Err(failure(
            "name",
            "Remove line breaks and other control characters.",
        ));
    }
    Ok(name.to_owned())
}

/// Trims and lowercases, then requires 3 to 254 printable ASCII characters with exactly one `@` and
/// non-empty parts on both sides. ASCII only, like the auth crate, which blocks look-alike addresses.
pub fn email(raw: &str) -> AppResult<String> {
    let value = raw.trim().to_ascii_lowercase();
    let length = value.chars().count();
    let printable = value.bytes().all(|byte| (0x21..=0x7e).contains(&byte));
    if !(3..=254).contains(&length) || !printable {
        return Err(failure("email", "Enter a valid email address."));
    }
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(failure("email", "Enter a valid email address."));
    };
    if local.is_empty() || domain.is_empty() {
        return Err(failure("email", "Enter a valid email address."));
    }
    Ok(value)
}

/// Invites can grant admin, member or viewer. Ownership only moves through transfer.
pub fn invite_role(raw: &str) -> AppResult<TeamRole> {
    if raw.len() > 32 {
        return Err(failure("role", "Choose admin, member or viewer."));
    }
    match TeamRole::parse(raw) {
        Some(TeamRole::Owner) => Err(failure(
            "role",
            "Invites can't grant ownership. Transfer it once they've joined.",
        )),
        Some(role) => Ok(role),
        None => Err(failure("role", "Choose admin, member or viewer.")),
    }
}

/// Roles a member can be given directly. Owner is refused here, pointing at transfer.
pub fn member_role(raw: &str) -> AppResult<TeamRole> {
    if raw.len() > 32 {
        return Err(failure("role", "Choose admin, member or viewer."));
    }
    match TeamRole::parse(raw) {
        Some(TeamRole::Owner) => Err(failure("role", "Use transfer to make someone the owner.")),
        Some(role) => Ok(role),
        None => Err(failure("role", "Choose admin, member or viewer.")),
    }
}

/// Parses an id from the path. Anything that isn't a UUID can't name a team, so it's a 404.
pub fn uuid_param(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found())
}

/// Parses an id from a body. Here a bad value is a validation error for that field.
pub fn uuid_field(raw: &str, path: &str) -> AppResult<Uuid> {
    if raw.len() > 36 {
        return Err(failure(path, "Choose a member from this team."));
    }
    Uuid::parse_str(raw).map_err(|_| failure(path, "Choose a member from this team."))
}

/// Turns the token from an invite link into its stored hash. Anything that isn't a well-formed token
/// gets the same generic error as an expired or revoked invite, so the response reveals nothing.
pub fn invite_token(raw: &str) -> AppResult<[u8; 32]> {
    crypto::hash_token(raw.trim()).ok_or_else(crate::service::invalid_invite)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn team_names_are_trimmed_and_bounded() {
        assert_eq!(team_name("  Night Owls  ").unwrap(), "Night Owls");
        assert_eq!(team_name(&"é".repeat(80)).unwrap().chars().count(), 80);
        assert!(team_name("   ").is_err());
        assert!(team_name(&"x".repeat(81)).is_err());
        assert!(team_name("line\nbreak").is_err());
        assert!(team_name("bell\u{7}").is_err());
    }

    #[test]
    fn emails_are_normalised_and_checked() {
        assert_eq!(email("  Ann@Example.COM ").unwrap(), "ann@example.com");
        for invalid in [
            "",
            "ab",
            "a@",
            "@b.com",
            "a@@b.com",
            "a@b@c.com",
            "a b@c.com",
            "a\n@b.com",
            "用户@x.com",
            "аnn@example.com",
        ] {
            assert!(email(invalid).is_err(), "{invalid:?}");
        }
        assert!(email(&format!("{}@x.com", "a".repeat(250))).is_err());
    }

    #[test]
    fn invite_roles_never_grant_ownership() {
        assert_eq!(invite_role("admin").unwrap(), TeamRole::Admin);
        assert_eq!(invite_role("viewer").unwrap(), TeamRole::Viewer);
        assert!(invite_role("owner").is_err());
        assert!(invite_role("root").is_err());
        assert!(member_role("owner").is_err());
        assert_eq!(member_role("member").unwrap(), TeamRole::Member);
    }

    #[test]
    fn bad_path_ids_are_not_found_and_bad_body_ids_are_validation_errors() {
        assert_eq!(uuid_param("nope").unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(
            uuid_field("nope", "userId").unwrap_err().code,
            ErrorCode::ValidationFailed
        );
        let id = Uuid::new_v4();
        assert_eq!(uuid_param(&id.to_string()).unwrap(), id);
    }

    #[test]
    fn malformed_invite_tokens_look_like_expired_ones() {
        let malformed = invite_token("short").unwrap_err();
        assert_eq!(malformed.code, ErrorCode::NotFound);
        let (token, hash) = crypto::new_token();
        assert_eq!(invite_token(&token).unwrap(), hash);
    }
}
