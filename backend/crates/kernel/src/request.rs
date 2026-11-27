//! Who sent a request and from where: request id, client IP and user agent.

use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, request::Parts},
};
use secrecy::ExposeSecret;

use crate::{AppError, AppState, crypto};

tokio::task_local! {
    /// Set by the request-id middleware for the whole request, so errors can quote it.
    pub static REQUEST_ID: String;
}

pub fn current_request_id() -> String {
    REQUEST_ID.try_with(Clone::clone).unwrap_or_default()
}

/// Reuses a well-formed incoming id so logs join up across services; otherwise makes a new one.
pub fn request_id_from(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            (8..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

#[derive(Clone, Debug)]
pub struct RequestMeta {
    pub ip: String,
    pub user_agent: String,
    pub request_id: String,
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The client IP, trusting only what can't be forged:
/// 1. `x-client-ip` signed by the Next.js proxy with PROXY_SECRET (`x-client-ip-signature`, hex HMAC);
/// 2. the configured number of trusted hops from the right of X-Forwarded-For;
/// 3. the TCP peer address.
pub fn client_ip(state: &AppState, headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    if let (Some(secret), Some(ip), Some(signature)) = (
        state.config.proxy_secret.as_ref(),
        header(headers, "x-client-ip"),
        header(headers, "x-client-ip-signature"),
    ) {
        let expected = crypto::hmac_sha256(
            secret.expose_secret().as_bytes(),
            &[b"client-ip", ip.as_bytes()],
        );
        if let Ok(given) = hex::decode(signature)
            && crypto::constant_time_eq(&given, &expected)
            && ip.parse::<IpAddr>().is_ok()
        {
            return ip.to_owned();
        }
    }

    let hops = state.config.trusted_proxy_hops;
    if hops > 0
        && let Some(forwarded) = header(headers, "x-forwarded-for")
    {
        let chain: Vec<&str> = forwarded.split(',').map(str::trim).collect();
        if chain.len() >= hops
            && let Some(candidate) = chain.get(chain.len() - hops)
            && candidate.parse::<IpAddr>().is_ok()
        {
            return (*candidate).to_owned();
        }
    }

    peer.map(|address| address.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

impl FromRequestParts<AppState> for RequestMeta {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0);
        let user_agent: String = header(&parts.headers, "user-agent")
            .unwrap_or_default()
            .chars()
            .filter(|character| !character.is_control())
            .take(512)
            .collect();
        Ok(Self {
            ip: client_ip(state, &parts.headers, peer),
            user_agent,
            request_id: current_request_id(),
        })
    }
}
