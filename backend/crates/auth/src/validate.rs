use kernel::{AppError, AppResult, ErrorCode};

pub fn failure(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(serde_json::json!([{ "path": path, "message": message }]))
}

pub fn length(value: &str, path: &str, min: usize, max: usize) -> AppResult<()> {
    if !(min..=max).contains(&value.chars().count()) {
        return Err(failure(path, "Invalid length."));
    }
    Ok(())
}

/// Characters allowed in the local part without quoting (RFC 5322 "atext"), plus dots.
fn local_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&byte)
}

/// A practical, deliverable address: ASCII only (international domains as punycode `xn--`), no quoted
/// local parts or IP literals, at least one dot in the domain, and a letter-only or punycode TLD.
/// Rejecting Unicode also blocks look-alike (homograph) addresses and SMTPUTF8 delivery failures.
fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if domain.contains('@') || local.is_empty() || local.len() > 64 || domain.len() > 253 {
        return false;
    }
    let local_ok = local.bytes().all(local_char)
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..");
    let labels: Vec<&str> = domain.split('.').collect();
    let labels_ok = labels.len() >= 2
        && labels.iter().all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    let tld_ok = labels.last().is_some_and(|tld| {
        (tld.len() >= 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic()))
            || tld.starts_with("xn--")
    });
    local_ok && labels_ok && tld_ok
}

pub fn email(value: &str) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    length(&value, "email", 3, 254)?;
    if !valid_email(&value) {
        return Err(failure("email", "Enter a valid email address."));
    }
    Ok(value)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_normalises_ordinary_addresses() {
        assert_eq!(email("  Test@Example.COM  ").unwrap(), "test@example.com");
        for valid in [
            "a.b+tag@sub.example.co.uk",
            "o'neil@example.ie",
            "x@xn--bcher-kva.example",
        ] {
            assert!(email(valid).is_ok(), "{valid}");
        }
    }

    #[test]
    fn rejects_malformed_and_risky_addresses() {
        for invalid in [
            "a@@b.com",
            "@example.com",
            "a b@example.com",
            "a@",
            "a@localhost",
            "a@example.c0m",
            ".a@example.com",
            "a..b@example.com",
            "a@-example.com",
            "a@exa_mple.com",
            "\"quoted\"@example.com",
            "a@[127.0.0.1]",
            "用户@example.test",
            "аpple@example.com",
            "a' OR 1=1--@example.test",
            "a\nb@example.com",
        ] {
            assert!(email(invalid).is_err(), "{invalid:?}");
        }
    }
}
