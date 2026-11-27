//! Address search through a Nominatim-compatible geocoder.
//!
//! The server, not the client, decides where requests go: the URL comes only from `GEOCODER_URL`, and
//! the user's text is sent as one encoded `q` parameter. Redirects are not followed, the answer is
//! size-capped and timed out, and only well-formed coordinates are passed on. Results are cached for a
//! day so repeated searches don't reach the geocoder again.

use std::{sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{RawQuery, State},
    http::header,
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, crypto,
    security::{Limit, enforce_rate_limit},
    viewer::Viewer,
};
use reqwest::{Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::validate::{self, Problems};

/// Searches per person per minute. Applies to cache hits too, so the table can't be flooded either.
pub const GEOCODE_LIMIT: Limit = Limit {
    limit: 30,
    window: Duration::from_secs(60),
};
const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_RESULTS: usize = 5;
const MAX_LABEL_CHARS: usize = 300;

/// One address match, in the shape clients receive.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Found {
    pub label: String,
    pub lat: f64,
    pub lng: f64,
}

/// A configured geocoder. Cheap to clone; the client is shared.
#[derive(Clone)]
pub struct Geocoder {
    url: Url,
    client: reqwest::Client,
}

impl Geocoder {
    /// Reads `GEOCODER_URL`. Unset means address search is off. A bad value is logged and also turns
    /// search off, so a typo can't quietly send requests somewhere unexpected.
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var("GEOCODER_URL").ok()?;
        if raw.trim().is_empty() {
            return None;
        }
        let production =
            std::env::var("APP_ENV").is_ok_and(|value| value.eq_ignore_ascii_case("production"));
        match Self::new(&raw, production) {
            Ok(geocoder) => Some(geocoder),
            Err(reason) => {
                tracing::error!(reason, "GEOCODER_URL rejected; address search is off");
                None
            }
        }
    }

    /// Checks the URL and builds the client. The reason is safe to log; it never echoes the URL.
    pub fn new(raw: &str, production: bool) -> Result<Self, &'static str> {
        let url = Url::parse(raw.trim()).map_err(|_| "not a valid URL")?;
        match url.scheme() {
            "https" => {}
            "http" if !production => {}
            _ => return Err("must use https in production"),
        }
        if url.host_str().is_none_or(str::is_empty) {
            return Err("has no host");
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("must not contain credentials");
        }
        if url.fragment().is_some() {
            return Err("must not contain a fragment");
        }
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(Policy::none())
            .user_agent("invigil-places")
            .build()
            .map_err(|_| "could not build the HTTP client")?;
        Ok(Self { url, client })
    }

    async fn lookup(&self, query: &str) -> AppResult<Vec<Found>> {
        let mut url = self.url.clone();
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("format", "jsonv2")
            .append_pair("limit", &MAX_RESULTS.to_string());
        let mut response = self
            .client
            .get(url)
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| {
                upstream_failed(if error.is_timeout() {
                    "timeout"
                } else {
                    "network"
                })
            })?;
        // Redirects arrive here as 3xx, because they aren't followed. Anything but 200 is a failure.
        if response.status() != reqwest::StatusCode::OK {
            return Err(upstream_failed("unexpected status"));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(upstream_failed("response too large"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| upstream_failed("read failed"))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(upstream_failed("response too large"));
            }
            body.extend_from_slice(&chunk);
        }
        let items: Vec<Value> =
            serde_json::from_slice(&body).map_err(|_| upstream_failed("not a JSON list"))?;
        Ok(items
            .iter()
            .filter_map(parse_match)
            .take(MAX_RESULTS)
            .collect())
    }
}

fn unavailable() -> AppError {
    AppError::new(
        ErrorCode::Unavailable,
        "Address search is busy right now. Try again in a moment.",
    )
    .retry_after(10)
}

fn upstream_failed(reason: &str) -> AppError {
    tracing::warn!(reason, "geocoder request failed");
    unavailable()
}

/// Keeps a match only when it has a label and coordinates that are real numbers in range.
pub fn parse_match(item: &Value) -> Option<Found> {
    let lat = coordinate(item.get("lat")?)?;
    let lng = coordinate(item.get("lon")?)?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return None;
    }
    let label: String = item
        .get("display_name")?
        .as_str()?
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_LABEL_CHARS)
        .collect();
    if label.is_empty() {
        return None;
    }
    Some(Found { label, lat, lng })
}

/// Geocoders send coordinates as strings; accept numbers too.
fn coordinate(value: &Value) -> Option<f64> {
    let number = match value {
        Value::String(text) => text.parse::<f64>().ok()?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// Searches are compared case- and space-insensitively, so "Paris" and " paris " share a cache entry.
pub fn cache_key(query: &str) -> [u8; 32] {
    let normalised = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    crypto::sha256(normalised.as_bytes())
}

async fn cached(db: &PgPool, key: &[u8; 32]) -> AppResult<Option<Vec<Found>>> {
    let value: Option<Value> = sqlx::query_scalar(
        "select results from geocode_cache
         where query_hash = $1 and fetched_at > now() - interval '24 hours'",
    )
    .bind(key.as_slice())
    .fetch_optional(db)
    .await?;
    // A row that no longer parses is treated as a miss and replaced below.
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// Best effort: a failed cache write doesn't fail the search.
async fn store(db: &PgPool, key: &[u8; 32], found: &[Found]) {
    let Ok(value) = serde_json::to_value(found) else {
        return;
    };
    let result = sqlx::query(
        "insert into geocode_cache (query_hash, results, fetched_at) values ($1, $2, now())
         on conflict (query_hash) do update set results = excluded.results, fetched_at = excluded.fetched_at",
    )
    .bind(key.as_slice())
    .bind(value)
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::warn!(error = %error, "geocode cache write failed");
    }
    // Expired rows go a few at a time, so the table stays small without a long delete.
    let _ = sqlx::query(
        "delete from geocode_cache where query_hash in (
             select query_hash from geocode_cache where fetched_at < now() - interval '24 hours' limit 50)",
    )
    .execute(db)
    .await;
}

/// `GET /places/geocode?q=`: signed-in people only, rate limited per person.
pub async fn search(
    State(state): State<AppState>,
    axum::Extension(geocoder): axum::Extension<Arc<Option<Geocoder>>>,
    viewer: Viewer,
    RawQuery(raw): RawQuery,
) -> AppResult<Json<Value>> {
    let params = validate::query_params(raw.as_deref(), &["q"])?;
    let mut problems = Problems::default();
    let query = validate::text(
        &mut problems,
        "?q",
        params.get("q").map(String::as_str).unwrap_or(""),
        200,
        false,
    );
    if query.chars().count() < 2 {
        problems.add("?q", "Type at least 2 characters.");
    }
    problems.finish()?;

    let Some(geocoder) = geocoder.as_ref() else {
        return Err(AppError::new(
            ErrorCode::NotConfigured,
            "Address search isn't set up on this server.",
        ));
    };
    enforce_rate_limit(
        &state.db,
        &format!("places:geocode:{}", viewer.id),
        GEOCODE_LIMIT,
    )
    .await?;

    let key = cache_key(&query);
    if let Some(found) = cached(&state.db, &key).await? {
        return Ok(Json(json!({ "data": found })));
    }
    let found = geocoder.lookup(&query).await?;
    store(&state.db, &key, &found).await;
    Ok(Json(json!({ "data": found })))
}
