use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
    password_hash::{SaltString, rand_core::OsRng},
};
use kernel::{AppError, AppResult, AppState, ErrorCode};
use sha1::{Digest, Sha1};
use std::sync::OnceLock;

fn engine() -> AppResult<Argon2<'static>> {
    Ok(Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(AppError::internal)?,
    ))
}
fn hash_sync(password: &str) -> AppResult<String> {
    engine()?
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|h| h.to_string())
        .map_err(AppError::internal)
}
pub async fn hash(state: &AppState, password: String) -> AppResult<String> {
    let permit = state
        .hashing
        .clone()
        .acquire_owned()
        .await
        .map_err(AppError::internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash_sync(&password)
    })
    .await
    .map_err(AppError::internal)?
}
pub async fn verify(
    state: &AppState,
    password: String,
    stored: Option<String>,
) -> AppResult<(bool, bool)> {
    let permit = state
        .hashing
        .clone()
        .acquire_owned()
        .await
        .map_err(AppError::internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        static DUMMY: OnceLock<Result<String, String>> = OnceLock::new();
        let dummy =
            DUMMY.get_or_init(|| hash_sync("fixed dummy password").map_err(|e| e.to_string()));
        let value = match stored.as_deref() {
            Some(value) => value,
            None => dummy.as_deref().map_err(AppError::internal)?,
        };
        let parsed = PasswordHash::new(value).map_err(AppError::internal)?;
        let valid = engine()?
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
            && stored.is_some();
        let old = parsed.algorithm.as_str() != "argon2id"
            || parsed.version != Some(19)
            || parsed.params.get_decimal("m") != Some(19456)
            || parsed.params.get_decimal("t") != Some(2)
            || parsed.params.get_decimal("p") != Some(1);
        Ok((valid, old))
    })
    .await
    .map_err(AppError::internal)?
}
/// Cheap local rules only: no network, so it is safe to run before any rate-limit budget is spent.
pub fn check_local(email: &str, password: &str) -> AppResult<()> {
    if !(8..=128).contains(&password.chars().count())
        || password.eq_ignore_ascii_case(email)
        || email
            .split('@')
            .next()
            .is_some_and(|local| password.eq_ignore_ascii_case(local))
    {
        return Err(AppError::new(
            ErrorCode::WeakPassword,
            "Choose a stronger password of 8 to 128 characters.",
        ));
    }
    Ok(())
}

/// Checks the password against the public breach list (HIBP range API). This makes an outbound
/// call, so callers that can be abused should run it behind their budget. Fails open when the
/// service is unreachable, so an outage never blocks sign-in.
pub async fn breach_check(state: &AppState, password: &str) -> AppResult<()> {
    if !state.config.breach_check {
        return Ok(());
    }
    // k-anonymity: only the first five hex characters of the SHA-1 leave the server.
    let digest = hex::encode_upper(Sha1::digest(password.as_bytes()));
    let result = async {
        let response = state
            .http
            .get(format!(
                "https://api.pwnedpasswords.com/range/{}",
                &digest[..5]
            ))
            .header("Add-Padding", "true")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        response.text().await
    }
    .await;
    match result {
        Ok(body) => {
            if breached_in(&body, &digest[5..]) {
                return Err(AppError::new(
                    ErrorCode::WeakPassword,
                    "This password has appeared in a breach. Choose another.",
                ));
            }
        }
        Err(err) => tracing::warn!(error = %err, "password breach check unavailable"),
    }
    Ok(())
}

/// Reads an HIBP range body (`SUFFIX:COUNT` lines, possibly CRLF and zero-count padding lines).
fn breached_in(body: &str, suffix: &str) -> bool {
    body.lines()
        .filter_map(|line| line.trim().split_once(':'))
        .any(|(candidate, count)| {
            candidate.eq_ignore_ascii_case(suffix) && count.parse::<u64>().unwrap_or(0) > 0
        })
}

/// The full check, local rules first, then the breach list. Used by reset, change and MFA.
pub async fn policy(state: &AppState, email: &str, password: &str) -> AppResult<()> {
    check_local(email, password)?;
    breach_check(state, password).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_rules_accept_the_length_boundaries() {
        assert!(check_local("a@example.com", &"x".repeat(8)).is_ok());
        assert!(check_local("a@example.com", &"x".repeat(128)).is_ok());
        // Length counts characters, not bytes: 8 multi-byte characters are still in range.
        assert!(check_local("a@example.com", &"é".repeat(8)).is_ok());
    }

    #[test]
    fn local_rules_reject_out_of_range_lengths() {
        let too_short = "x".repeat(7);
        let too_long = "x".repeat(129);
        for password in ["", "short", too_short.as_str(), too_long.as_str()] {
            let error = check_local("a@example.com", password).err();
            assert_eq!(
                error.map(|e| e.code),
                Some(ErrorCode::WeakPassword),
                "{password:?}"
            );
        }
    }

    #[test]
    fn local_rules_reject_the_email_or_its_local_part_in_any_case() {
        // The local part is eight characters, so these fail on the equality rules, not length.
        for password in ["LongName@Example.com", "LONGNAME@EXAMPLE.COM", "LongName"] {
            let error = check_local("longname@example.com", password).err();
            assert_eq!(
                error.map(|e| e.code),
                Some(ErrorCode::WeakPassword),
                "{password}"
            );
        }
        // The local part only matches as a whole password, not as a prefix of one.
        assert!(check_local("longname@example.com", "longname-and-more").is_ok());
    }

    #[test]
    fn breached_in_matches_suffix_ignoring_case_and_line_endings() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:12\r\n\
                    00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n";
        assert!(breached_in(body, "0018a45c4d1def81644b54ab7f969b88d65"));
        assert!(breached_in(body, "0018A45C4D1DEF81644B54AB7F969B88D65"));
    }

    #[test]
    fn breached_in_ignores_zero_count_padding_and_other_suffixes() {
        let body = "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\n\
                    0018A45C4D1DEF81644B54AB7F969B88D65:not-a-number\n";
        assert!(!breached_in(body, "00D4F6E8FA6EECAD2A3AA415EEC418D38EC"));
        assert!(!breached_in(body, "0018A45C4D1DEF81644B54AB7F969B88D65"));
        assert!(!breached_in("", "0018A45C4D1DEF81644B54AB7F969B88D65"));
    }
}
