//! Stripe's `Stripe-Signature` check.
//!
//! The header is `t=<unix time>,v1=<hex>[,v1=<hex>...]`. Stripe signs `"<t>.<raw body>"` with
//! HMAC-SHA256 and the endpoint secret. Several v1 values can appear while a secret is rotated, and
//! any one of them is valid. Timestamps further than five minutes away are refused, which limits
//! how long a captured request could be replayed.
//!
//! The body must be the exact bytes Stripe sent. Re-serialised JSON would never match.

use hmac::{Hmac, Mac};
use kernel::crypto::constant_time_eq;
use sha2::Sha256;

pub const TOLERANCE_SECS: i64 = 300;
const MAX_HEADER_BYTES: usize = 1024;
/// Only a little more than the number of live secrets ever needs. Bounds the work per request.
const MAX_SIGNATURES: usize = 10;

#[derive(Debug, PartialEq, Eq)]
pub enum SignatureError {
    Malformed,
    Expired,
    Mismatch,
}

/// `now` is passed in so tests can pin the clock.
pub fn verify(secret: &[u8], header: &str, body: &[u8], now: i64) -> Result<(), SignatureError> {
    if header.len() > MAX_HEADER_BYTES {
        return Err(SignatureError::Malformed);
    }
    let mut timestamp: Option<&str> = None;
    let mut candidates: Vec<Vec<u8>> = Vec::new();
    for part in header.split(',') {
        let Some((name, value)) = part.trim().split_once('=') else {
            continue;
        };
        match name {
            // The first timestamp counts. Its text is signed as sent, so it isn't re-formatted.
            "t" if timestamp.is_none() => timestamp = Some(value),
            "v1" if candidates.len() < MAX_SIGNATURES => {
                // Only a 32-byte SHA-256 MAC is worth comparing; other lengths are ignored.
                if let Ok(bytes) = hex::decode(value)
                    && bytes.len() == 32
                {
                    candidates.push(bytes);
                }
            }
            _ => {}
        }
    }
    let raw = timestamp.ok_or(SignatureError::Malformed)?;
    let parsed: i64 = raw.parse().map_err(|_| SignatureError::Malformed)?;
    if candidates.is_empty() {
        return Err(SignatureError::Malformed);
    }
    if (now - parsed).abs() > TOLERANCE_SECS {
        return Err(SignatureError::Expired);
    }

    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| SignatureError::Malformed)?;
    mac.update(raw.as_bytes());
    mac.update(b".");
    mac.update(body);
    let expected = mac.finalize().into_bytes();

    // Every candidate is compared, with no early exit, so timing doesn't reveal which one matched.
    let mut matched = false;
    for candidate in &candidates {
        matched |= constant_time_eq(candidate, &expected);
    }
    if matched {
        Ok(())
    } else {
        Err(SignatureError::Mismatch)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"whsec_test_secret";
    const BODY: &[u8] = br#"{"id":"evt_1","type":"invoice.paid"}"#;
    const NOW: i64 = 1_800_000_000;

    fn mac_hex(secret: &[u8], timestamp: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).unwrap();
        mac.update(timestamp.as_bytes());
        mac.update(b".");
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    fn header(timestamp: i64, signatures: &[String]) -> String {
        let mut value = format!("t={timestamp}");
        for signature in signatures {
            value.push_str(&format!(",v1={signature}"));
        }
        value
    }

    #[test]
    fn a_valid_signature_is_accepted() {
        let sig = mac_hex(SECRET, &NOW.to_string(), BODY);
        assert_eq!(verify(SECRET, &header(NOW, &[sig]), BODY, NOW), Ok(()));
    }

    #[test]
    fn a_wrong_secret_is_refused() {
        let sig = mac_hex(b"whsec_other", &NOW.to_string(), BODY);
        assert_eq!(
            verify(SECRET, &header(NOW, &[sig]), BODY, NOW),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn a_tampered_body_is_refused() {
        let sig = mac_hex(SECRET, &NOW.to_string(), BODY);
        let tampered = br#"{"id":"evt_1","type":"invoice.paid","x":1}"#;
        assert_eq!(
            verify(SECRET, &header(NOW, &[sig]), tampered, NOW),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn an_old_timestamp_is_refused_and_the_edge_is_allowed() {
        let old = NOW - TOLERANCE_SECS - 1;
        let sig = mac_hex(SECRET, &old.to_string(), BODY);
        assert_eq!(
            verify(SECRET, &header(old, &[sig]), BODY, NOW),
            Err(SignatureError::Expired)
        );

        let edge = NOW - TOLERANCE_SECS;
        let sig = mac_hex(SECRET, &edge.to_string(), BODY);
        assert_eq!(verify(SECRET, &header(edge, &[sig]), BODY, NOW), Ok(()));
    }

    #[test]
    fn a_far_future_timestamp_is_refused() {
        let future = NOW + TOLERANCE_SECS + 1;
        let sig = mac_hex(SECRET, &future.to_string(), BODY);
        assert_eq!(
            verify(SECRET, &header(future, &[sig]), BODY, NOW),
            Err(SignatureError::Expired)
        );
    }

    #[test]
    fn any_one_of_several_v1_signatures_is_enough() {
        let good = mac_hex(SECRET, &NOW.to_string(), BODY);
        let stale = mac_hex(b"whsec_rotated_out", &NOW.to_string(), BODY);
        assert_eq!(
            verify(SECRET, &header(NOW, &[stale.clone(), good]), BODY, NOW),
            Ok(())
        );
        assert_eq!(
            verify(SECRET, &header(NOW, &[stale.clone(), stale]), BODY, NOW),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn malformed_headers_are_refused() {
        let sig = mac_hex(SECRET, &NOW.to_string(), BODY);
        assert_eq!(
            verify(SECRET, "", BODY, NOW),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify(SECRET, &format!("v1={sig}"), BODY, NOW),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify(SECRET, &format!("t={NOW}"), BODY, NOW),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify(SECRET, &format!("t={NOW},v0={sig}"), BODY, NOW),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify(SECRET, &format!("t=abc,v1={sig}"), BODY, NOW),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify(SECRET, &format!("t={NOW},v1=zz"), BODY, NOW),
            Err(SignatureError::Malformed)
        );
        let long = "a".repeat(MAX_HEADER_BYTES + 1);
        assert_eq!(
            verify(SECRET, &long, BODY, NOW),
            Err(SignatureError::Malformed)
        );
    }
}
