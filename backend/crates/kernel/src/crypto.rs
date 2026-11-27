//! Small, audited-library-backed helpers. All randomness comes from the OS.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::{Rng, RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// A fresh 256-bit token for the client, and the SHA-256 the database keeps instead.
pub fn new_token() -> (String, [u8; 32]) {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = sha256(token.as_bytes());
    (token, hash)
}

/// Hashes a token the client sent back. Rejects anything that can't be one of ours.
pub fn hash_token(token: &str) -> Option<[u8; 32]> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(sha256(token.as_bytes()))
}

pub fn sha256(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

/// HMAC-SHA256 over the parts, each length-prefixed so ("ab","c") and ("a","bc") differ.
pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    #[allow(clippy::expect_used)]
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// Compares secrets without leaking how much of them matched through timing.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

/// A uniformly random numeric code, such as "042917". No modulo bias.
pub fn random_digits(length: usize) -> String {
    (0..length)
        .map(|_| char::from(b'0' + OsRng.gen_range(0..10u8)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_and_reject_junk() {
        let (token, hash) = new_token();
        assert_eq!(hash_token(&token), Some(hash));
        assert_eq!(hash_token("short"), None);
        assert_eq!(hash_token(&format!("{}!", &token[..42])), None);
    }

    #[test]
    fn hmac_parts_are_unambiguous() {
        assert_ne!(
            hmac_sha256(b"k", &[b"ab", b"c"]),
            hmac_sha256(b"k", &[b"a", b"bc"])
        );
    }

    #[test]
    fn digits_have_the_right_shape() {
        let code = random_digits(6);
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
    }
}
