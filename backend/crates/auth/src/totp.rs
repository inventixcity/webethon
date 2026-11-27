//! RFC 6238 TOTP primitives. Persistence and replay protection are handled by callers.

use hmac::{Hmac, Mac};
use kernel::crypto::constant_time_eq;
use sha1::Sha1;

fn hotp(secret: &[u8], step: u64, digits: u32) -> String {
    #[allow(clippy::expect_used)]
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let binary = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    format!(
        "{:0width$}",
        binary % 10_u32.pow(digits),
        width = digits as usize
    )
}

/// Returns the latest matching step in the permitted clock window, if any.
/// The caller must atomically reject a step that has already been used.
pub fn matching_step(secret: &[u8], code: &str, unix_seconds: u64) -> Option<i64> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let current = unix_seconds / 30;
    let mut matched = None;
    for step in [
        current.checked_sub(1),
        Some(current),
        current.checked_add(1),
    ]
    .into_iter()
    .flatten()
    {
        let expected = hotp(secret, step, 6);
        if constant_time_eq(expected.as_bytes(), code.as_bytes()) {
            matched = i64::try_from(step).ok();
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_6238_sha1_vectors() {
        let secret = b"12345678901234567890";
        for (time, expected) in [
            (59, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ] {
            assert_eq!(hotp(secret, time / 30, 8), expected);
        }
    }

    #[test]
    fn matches_only_the_three_step_window() {
        let secret = b"12345678901234567890";
        let code = hotp(secret, 100, 6);
        assert_eq!(matching_step(secret, &code, 99 * 30), Some(100));
        assert_eq!(matching_step(secret, &code, 100 * 30), Some(100));
        assert_eq!(matching_step(secret, &code, 101 * 30), Some(100));
        assert_eq!(matching_step(secret, &code, 102 * 30), None);
        assert_eq!(matching_step(secret, "invalid", 100 * 30), None);
    }
}
