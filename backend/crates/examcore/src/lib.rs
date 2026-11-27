//! Shared building blocks for every Invigil exam crate.
//!
//! - Role extractors: [`ExaminerViewer`], [`CandidateViewer`], [`AdminViewer`].
//! - Access checks: [`load_exam_for_examiner`] (owner or admin, otherwise 404 — never leak existence).
//! - Lifecycle: [`phase`] derives `draft | scheduled | ongoing | closed | completed | archived`.
//! - Scoring: [`score_objective`], the ONE marking function for objective items. Grading, attempts and
//!   resilience all call it, so the marking scheme can never diverge between code paths.
//! - 5.3 resilience primitives: signed time [`Lease`]s and the offline journal hash chain [`chain_next`].
//! - 4.6 verifiable results: Ed25519 signing via [`signer`].
//!
//! Money-like values (marks) travel as `f64` rounded to 2 dp; SQL casts `numeric` columns with `::float8`.

use std::sync::OnceLock;

use axum::{extract::FromRequestParts, http::request::Parts};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
pub use kernel::{AppError, AppResult, AppState, ErrorCode, Viewer};
use kernel::crypto;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

pub use kernel;

// ------------------------------------------------------------------ responses

/// Wraps a successful payload in the API envelope `{"data": ...}`. EVERY success response must use this
/// (the web client's `api()` unwraps `data`).
pub fn ok<T: Serialize>(value: T) -> axum::Json<Value> {
    axum::Json(json!({ "data": value }))
}

/// Result alias for handlers returning the envelope.
pub type ApiJson = AppResult<axum::Json<Value>>;

// ------------------------------------------------------------------ errors

/// A 422 with one field error, in the kit's error envelope (`details: [{path, message}]`).
pub fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(ErrorCode::ValidationFailed, "Please check the highlighted fields.")
        .with_details(json!([{ "path": path, "message": message }]))
}

/// A 422 with many field errors.
pub fn invalid_many(errors: Vec<(String, String)>) -> AppError {
    let details: Vec<Value> = errors
        .into_iter()
        .map(|(path, message)| json!({ "path": path, "message": message }))
        .collect();
    AppError::new(ErrorCode::ValidationFailed, "Please check the highlighted fields.")
        .with_details(Value::Array(details))
}

/// 409 with a machine-readable reason, e.g. `conflict("device", "...")`, `conflict("state", "...")`.
pub fn conflict(reason: &str, message: &str) -> AppError {
    AppError::new(ErrorCode::Conflict, message).with_details(json!({ "reason": reason }))
}

pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

// ------------------------------------------------------------------ role extractors

macro_rules! role_extractor {
    ($name:ident, $check:ident) => {
        /// Signed-in viewer with the required role; otherwise 401/403. Enforced server-side on every route.
        pub struct $name(pub Viewer);
        impl FromRequestParts<AppState> for $name {
            type Rejection = AppError;
            async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
                let viewer = Viewer::from_request_parts(parts, state).await?;
                viewer.$check()?;
                Ok(Self(viewer))
            }
        }
    };
}
role_extractor!(ExaminerViewer, require_examiner);
role_extractor!(CandidateViewer, require_candidate);
role_extractor!(AdminViewer, require_admin);

// ------------------------------------------------------------------ exams

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ExamRow {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub title: String,
    pub status: String,
    pub starts_at: OffsetDateTime,
    pub ends_at: OffsetDateTime,
    pub duration_minutes: i32,
    pub total_marks: f64,
    pub pass_marks: f64,
    pub settings: Value,
    pub results_published_at: Option<OffsetDateTime>,
    pub version: i32,
}

pub const EXAM_COLUMNS: &str = "id, owner_id, title, status, starts_at, ends_at, duration_minutes, \
    total_marks::float8 as total_marks, pass_marks::float8 as pass_marks, settings, results_published_at, version";

/// [`EXAM_COLUMNS`] qualified with a table alias, for joins.
pub fn exam_columns(alias: &str) -> String {
    format!(
        "{a}.id, {a}.owner_id, {a}.title, {a}.status, {a}.starts_at, {a}.ends_at, {a}.duration_minutes,          {a}.total_marks::float8 as total_marks, {a}.pass_marks::float8 as pass_marks, {a}.settings,          {a}.results_published_at, {a}.version",
        a = alias
    )
}

/// Loads an exam the viewer may manage: its owner, or any admin. Anything else is a 404 (no existence leak).
pub async fn load_exam_for_examiner(db: &PgPool, viewer: &Viewer, exam_id: Uuid) -> AppResult<ExamRow> {
    let sql = format!("select {EXAM_COLUMNS} from exams where id = $1 and deleted_at is null");
    let exam: Option<ExamRow> = sqlx::query_as(&sql).bind(exam_id).fetch_optional(db).await?;
    match exam {
        Some(exam) if exam.owner_id == viewer.id || viewer.is_admin() => Ok(exam),
        _ => Err(AppError::not_found()),
    }
}

/// Loads an exam a candidate is actively enrolled in and which is published (or later). Otherwise 404.
pub async fn load_exam_for_candidate(db: &PgPool, viewer: &Viewer, exam_id: Uuid) -> AppResult<(ExamRow, i32)> {
    let sql = format!(
        "select {}, e.extra_minutes from exams x join enrollments e on e.exam_id = x.id          where x.id = $1 and e.candidate_id = $2 and e.status = 'enrolled' and x.deleted_at is null          and x.status in ('published', 'completed')",
        exam_columns("x")
    );
    let row: Option<(ExamRow, i32)> = sqlx::query_as::<_, ExamWithExtra>(&sql)
        .bind(exam_id)
        .bind(viewer.id)
        .fetch_optional(db)
        .await?
        .map(|r| (r.exam, r.extra_minutes));
    row.ok_or_else(AppError::not_found)
}

#[derive(sqlx::FromRow)]
struct ExamWithExtra {
    #[sqlx(flatten)]
    exam: ExamRow,
    extra_minutes: i32,
}

/// Derived lifecycle phase. Spec states: draft, published (scheduled), ongoing, completed.
/// `closed` = window ended but the examiner has not marked the exam completed yet.
pub fn phase(status: &str, starts_at: OffsetDateTime, ends_at: OffsetDateTime, now: OffsetDateTime) -> &'static str {
    match status {
        "draft" => "draft",
        "archived" => "archived",
        "completed" => "completed",
        _ if now < starts_at => "scheduled",
        _ if now < ends_at => "ongoing",
        _ => "closed",
    }
}

/// RFC 3339 string for a timestamp. Use inside `json!()`: `OffsetDateTime`'s default serde form is an array.
pub fn iso(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

/// [`iso`] for optional timestamps (`null` stays `null`).
pub fn iso_opt(t: Option<OffsetDateTime>) -> Option<String> {
    t.map(iso)
}

/// Anything that can appear as a timestamp field in a `json!()` response.
pub trait IntoIso {
    fn into_iso(self) -> Value;
}
impl IntoIso for OffsetDateTime {
    fn into_iso(self) -> Value {
        Value::String(iso(self))
    }
}
impl IntoIso for Option<OffsetDateTime> {
    fn into_iso(self) -> Value {
        self.map_or(Value::Null, |t| Value::String(iso(t)))
    }
}
impl IntoIso for String {
    fn into_iso(self) -> Value {
        Value::String(self)
    }
}
impl IntoIso for Option<String> {
    fn into_iso(self) -> Value {
        self.map_or(Value::Null, Value::String)
    }
}

/// Timestamp field value for `json!()`: always an RFC 3339 string or null, never serde's array form.
pub fn ts(value: impl IntoIso) -> Value {
    value.into_iso()
}

pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

// ------------------------------------------------------------------ scoring

/// Item fields needed to mark an objective response.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarkingScheme {
    pub kind: String,
    pub correct: Vec<String>,
    pub option_count: usize,
    pub marks: f64,
    pub negative_marks: f64,
    pub multi_rule: String,
}

/// Marks for an objective response. `selected` empty = skipped = 0 (never negative).
/// Returns None for written items (manual grading).
///
/// single: full marks if the one chosen option is correct, else -negative_marks.
/// multi / all_or_nothing: full marks iff the chosen set equals the key, else -negative_marks.
/// multi / partial: marks * (correct chosen / key size), but 0 if ANY wrong option is chosen.
/// multi / partial_penalty: marks/key * correct chosen - marks/key * wrong chosen, floored at 0.
pub fn score_objective(scheme: &MarkingScheme, selected: &[String]) -> Option<f64> {
    if scheme.kind == "written" {
        return None;
    }
    let mut chosen: Vec<&String> = selected.iter().collect();
    chosen.sort();
    chosen.dedup();
    if chosen.is_empty() {
        return Some(0.0);
    }
    let right = chosen.iter().filter(|c| scheme.correct.contains(c)).count();
    let wrong = chosen.len() - right;
    let key = scheme.correct.len().max(1);
    let score = match (scheme.kind.as_str(), scheme.multi_rule.as_str()) {
        ("single", _) => {
            if chosen.len() == 1 && right == 1 { scheme.marks } else { -scheme.negative_marks }
        }
        (_, "partial") => {
            if wrong > 0 { 0.0 } else { scheme.marks * right as f64 / key as f64 }
        }
        (_, "partial_penalty") => {
            let per = scheme.marks / key as f64;
            (per * right as f64 - per * wrong as f64).max(0.0)
        }
        _ => {
            if wrong == 0 && right == key { scheme.marks } else { -scheme.negative_marks }
        }
    };
    Some(round2(score))
}

/// Pulls `selected` out of a stored response document.
pub fn selected_of(response: &Value) -> Vec<String> {
    response
        .get("selected")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ deterministic shuffling

/// Fisher–Yates with a SplitMix64 stream seeded per attempt. Same seed, same paper, on every device.
pub fn shuffle<T>(items: &mut [T], seed: u64) {
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    for i in (1..items.len()).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        items.swap(i, j);
    }
}

// ------------------------------------------------------------------ secrets

struct Keys {
    lease: Vec<u8>,
    signing: SigningKey,
    key_id: String,
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let production = std::env::var("APP_ENV").is_ok_and(|v| v == "production");
        let lease = std::env::var("EXAM_LEASE_KEY").ok().filter(|k| k.len() >= 32);
        let lease = match lease {
            Some(k) => k.into_bytes(),
            None => {
                if production {
                    tracing::error!("EXAM_LEASE_KEY (32+ chars) is required in production; leases use a random key");
                } else {
                    tracing::warn!("EXAM_LEASE_KEY not set; using a random development key");
                }
                crypto::new_token().0.into_bytes()
            }
        };
        let signing = std::env::var("RESULT_SIGNING_KEY")
            .ok()
            .and_then(|k| base64::engine::general_purpose::STANDARD.decode(k.trim()).ok())
            .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
            .map(|b| SigningKey::from_bytes(&b));
        let signing = match signing {
            Some(key) => key,
            None => {
                if production {
                    tracing::error!("RESULT_SIGNING_KEY (base64 of 32 bytes) is required in production");
                } else {
                    tracing::warn!("RESULT_SIGNING_KEY not set; using a random development key");
                }
                SigningKey::generate(&mut rand::rngs::OsRng)
            }
        };
        let key_id = hex::encode(&crypto::sha256(signing.verifying_key().as_bytes())[..8]);
        Keys { lease, signing, key_id }
    })
}

/// Call at startup so a missing production key is logged immediately rather than on first use.
pub fn init_keys() {
    let _ = keys();
}

/// Ed25519 signing for result certificates (4.6).
pub mod signer {
    use super::*;
    pub fn sign(message: &[u8]) -> ([u8; 64], String) {
        let k = keys();
        (k.signing.sign(message).to_bytes(), k.key_id.clone())
    }
    pub fn verify(message: &[u8], signature: &[u8]) -> bool {
        let Ok(sig) = ed25519_dalek::Signature::from_slice(signature) else { return false };
        keys().signing.verifying_key().verify_strict(message, &sig).is_ok()
    }
    pub fn public_key() -> VerifyingKey {
        keys().signing.verifying_key()
    }
    pub fn key_id() -> String {
        keys().key_id.clone()
    }
}

// ------------------------------------------------------------------ 5.3 time leases

/// A server-signed statement "attempt A was alive at server time T, deadline D". The client keeps the latest
/// lease; offline answers are stamped `lease.issued_at + monotonic elapsed`. On sync the server accepts an
/// offline entry only if the lease verifies, the claimed time is <= deadline, and the claimed elapsed time is
/// not larger than the real time between issue and receipt. A device clock is never trusted.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub attempt_id: Uuid,
    /// Unix milliseconds, server clock.
    pub issued_at: i64,
    pub deadline_at: i64,
    pub mac: String,
}

fn lease_mac(attempt_id: Uuid, issued_at: i64, deadline_at: i64) -> String {
    let mac = crypto::hmac_sha256(
        &keys().lease,
        &[b"lease.v1", attempt_id.as_bytes(), &issued_at.to_be_bytes(), &deadline_at.to_be_bytes()],
    );
    URL_SAFE_NO_PAD.encode(mac)
}

pub fn issue_lease(attempt_id: Uuid, deadline_at: OffsetDateTime) -> Lease {
    let issued_at = unix_ms(now());
    let deadline_at = unix_ms(deadline_at);
    Lease { attempt_id, issued_at, deadline_at, mac: lease_mac(attempt_id, issued_at, deadline_at) }
}

pub fn verify_lease(lease: &Lease, attempt_id: Uuid) -> bool {
    lease.attempt_id == attempt_id
        && crypto::constant_time_eq(
            lease_mac(lease.attempt_id, lease.issued_at, lease.deadline_at).as_bytes(),
            lease.mac.as_bytes(),
        )
}

pub fn unix_ms(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1_000_000) as i64
}

pub fn from_unix_ms(ms: i64) -> Option<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).ok()
}

// ------------------------------------------------------------------ 5.3 journal hash chain

/// h_n = SHA-256("journal.v1" | h_{n-1} | seq | item_id | canonical(response) | written_at_ms).
/// h_0 = attempts.journal_genesis (random, sent to the client with the attempt). The browser computes the same
/// chain with WebCrypto, so a reordered, dropped or edited offline entry breaks the chain and is rejected.
/// `canonical(response)` is serde_json's compact serialisation of the response object with keys sorted.
pub fn chain_next(prev: &[u8], seq: i64, item_id: Uuid, response: &Value, written_at_ms: i64) -> [u8; 32] {
    let canonical = canonical_json(response);
    let mut buf = Vec::with_capacity(96 + canonical.len());
    buf.extend_from_slice(b"journal.v1");
    buf.extend_from_slice(prev);
    buf.extend_from_slice(seq.to_string().as_bytes());
    buf.extend_from_slice(item_id.to_string().as_bytes());
    buf.extend_from_slice(canonical.as_bytes());
    buf.extend_from_slice(written_at_ms.to_string().as_bytes());
    crypto::sha256(&buf)
}

/// Compact JSON with object keys sorted recursively (matches `canonicalJson` in web/src/lib/exam/journal.ts).
pub fn canonical_json(value: &Value) -> String {
    fn sort(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = serde_json::Map::new();
                for k in keys {
                    out.insert(k.clone(), sort(&map[k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sort(value)).unwrap_or_default()
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheme(kind: &str, rule: &str, correct: &[&str]) -> MarkingScheme {
        MarkingScheme {
            kind: kind.into(),
            correct: correct.iter().map(|s| s.to_string()).collect(),
            option_count: 4,
            marks: 4.0,
            negative_marks: 1.0,
            multi_rule: rule.into(),
        }
    }
    fn sel(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn single_and_skip() {
        let s = scheme("single", "all_or_nothing", &["b"]);
        assert_eq!(score_objective(&s, &sel(&["b"])), Some(4.0));
        assert_eq!(score_objective(&s, &sel(&["a"])), Some(-1.0));
        assert_eq!(score_objective(&s, &sel(&[])), Some(0.0));
        assert_eq!(score_objective(&s, &sel(&["a", "b"])), Some(-1.0));
    }

    #[test]
    fn multi_rules() {
        let all = scheme("multi", "all_or_nothing", &["a", "c"]);
        assert_eq!(score_objective(&all, &sel(&["c", "a"])), Some(4.0));
        assert_eq!(score_objective(&all, &sel(&["a"])), Some(-1.0));
        let partial = scheme("multi", "partial", &["a", "c"]);
        assert_eq!(score_objective(&partial, &sel(&["a"])), Some(2.0));
        assert_eq!(score_objective(&partial, &sel(&["a", "b"])), Some(0.0));
        let penalty = scheme("multi", "partial_penalty", &["a", "c"]);
        assert_eq!(score_objective(&penalty, &sel(&["a", "c", "b"])), Some(2.0));
        assert_eq!(score_objective(&penalty, &sel(&["b", "d"])), Some(0.0));
    }

    #[test]
    fn shuffle_is_deterministic() {
        let mut a = vec![1, 2, 3, 4, 5, 6];
        let mut b = a.clone();
        shuffle(&mut a, 42);
        shuffle(&mut b, 42);
        assert_eq!(a, b);
    }

    #[test]
    fn lease_roundtrip() {
        let id = Uuid::new_v4();
        let lease = issue_lease(id, now());
        assert!(verify_lease(&lease, id));
        let mut forged = lease.clone();
        forged.deadline_at += 60_000;
        assert!(!verify_lease(&forged, id));
        assert!(!verify_lease(&lease, Uuid::new_v4()));
    }

    #[test]
    fn canonical_sorts_keys() {
        assert_eq!(canonical_json(&json!({"b":1,"a":{"d":2,"c":3}})), r#"{"a":{"c":3,"d":2},"b":1}"#);
    }
}
