//! Fail-closed outbound transport primitives. Record events are produced; comment, booking, payment and team events are not.
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::{Duration, Instant},
};
use url::{Host, Url};

const MAX_RESPONSE: usize = 256 * 1024;

/// Only allow globally routable unicast destinations; special-use ranges fail closed.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}
fn public_v6(ip: Ipv6Addr) -> bool {
    // IPv4-mapped/translated addresses, NAT64 and transition ranges are excluded.
    let s = ip.segments();
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
        && s[0] != 0x2002
}

/// Validate the URL before resolving it. Userinfo and fragments are never useful here.
pub fn parse_url(raw: &str, production: bool) -> anyhow::Result<Url> {
    anyhow::ensure!(raw.len() <= 2048, "Invalid webhook URL.");
    let url = Url::parse(raw).map_err(|_| anyhow::anyhow!("Invalid webhook URL."))?;
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
        "Invalid webhook URL."
    );
    let localhost = matches!(url.host(), Some(Host::Domain("localhost")));
    anyhow::ensure!(
        url.scheme() == "https" || (!production && localhost && url.scheme() == "http"),
        "Invalid webhook URL."
    );
    anyhow::ensure!(
        url.host().is_some() && url.port_or_known_default().is_some(),
        "Invalid webhook URL."
    );
    Ok(url)
}

/// Standard Webhooks signature, using the exact transmitted bytes.
pub fn signature(secret: &[u8], id: &str, timestamp: &str, body: &[u8]) -> String {
    // HMAC accepts keys of every length.
    #[allow(clippy::expect_used)]
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key");
    mac.update(id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
}

/// Only non-sensitive delivery metadata is returned; upstream content is discarded.
pub struct DeliveryResult {
    pub status: u16,
    pub duration_ms: u128,
}

/// Resolve once, reject mixed unsafe answers, and pin the approved addresses to this request.
/// A localhost exception is limited to loopback answers and development only.
pub async fn deliver(
    raw_url: &str,
    production: bool,
    id: &str,
    timestamp: &str,
    secret: &[u8],
    body: &[u8],
) -> anyhow::Result<DeliveryResult> {
    tokio::time::timeout(
        Duration::from_secs(10),
        deliver_inner(raw_url, production, id, timestamp, secret, body),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Delivery failed."))?
}
async fn deliver_inner(
    raw_url: &str,
    production: bool,
    id: &str,
    timestamp: &str,
    secret: &[u8],
    body: &[u8],
) -> anyhow::Result<DeliveryResult> {
    let started = Instant::now();
    let url = parse_url(raw_url, production)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid webhook URL."))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("Invalid webhook URL."))?;
    let localhost = !production && host == "localhost";
    let addresses: Vec<SocketAddr> = match url.host() {
        Some(Host::Ipv4(ip)) => vec![SocketAddr::new(ip.into(), port)],
        Some(Host::Ipv6(ip)) => vec![SocketAddr::new(ip.into(), port)],
        Some(Host::Domain(_)) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| anyhow::anyhow!("Delivery failed."))?
            .collect(),
        None => Vec::new(),
    };
    anyhow::ensure!(
        !addresses.is_empty()
            && addresses
                .iter()
                .all(|a| public_ip(a.ip()) || (localhost && a.ip().is_loopback())),
        "Delivery failed."
    );
    // No proxy: otherwise the proxy could resolve or reach a different destination.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| anyhow::anyhow!("Delivery failed."))?;
    let mut response = client
        .post(url)
        .header("content-type", "application/json")
        .header("Webhook-Id", id)
        .header("Webhook-Timestamp", timestamp)
        .header("Webhook-Signature", signature(secret, id, timestamp, body))
        .body(body.to_vec())
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Delivery failed."))?;
    let status = response.status().as_u16();
    let mut size = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Delivery failed."))?
    {
        size = size.saturating_add(chunk.len());
        anyhow::ensure!(size <= MAX_RESPONSE, "Delivery failed.");
    }
    Ok(DeliveryResult {
        status,
        duration_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn address_policy() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.1.1",
            "169.254.169.254",
            "172.31.0.1",
            "192.168.1.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:8.8.8.8",
            "2001:db8::1",
            "2002::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn url_policy() {
        assert!(parse_url("http://localhost:8080/", false).is_ok());
        assert!(parse_url("http://localhost:8080/", true).is_err());
        assert!(parse_url("http://127.0.0.1/", false).is_err());
        assert!(parse_url("https://user@example.com/", true).is_err());
        assert!(parse_url("https://example.com/#x", true).is_err());
    }
    #[tokio::test]
    async fn local_delivery_sends_exact_body_and_rejects_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let n = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..n]);
            assert!(request.to_ascii_lowercase().contains("webhook-signature:"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        let result = deliver(
            &format!("http://localhost:{port}/"),
            false,
            "event",
            "1",
            b"key",
            b"{}",
        )
        .await
        .unwrap();
        assert_eq!(result.status, 302);
        server.await.unwrap();
    }
    /// Answers one request with `status_line` and an empty body, then closes.
    async fn one_shot_server(status_line: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            let response =
                format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        (port, task)
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn delivery_status_codes_become_retry_or_delivered(db: sqlx::PgPool) {
        use crate::delivery::enqueue_test;
        use aes_gcm::{
            Aes256Gcm, KeyInit, Nonce,
            aead::{Aead, Payload},
        };
        use rand::{RngCore, rngs::OsRng};
        use secrecy::ExposeSecret;
        use std::sync::Arc;
        let config = Arc::new(kernel::config::Config::from_env().unwrap());
        // Localhost is only allowed outside production, so the test depends on that.
        assert!(!config.is_production());
        let state = kernel::state::AppState {
            db: db.clone(),
            config: config.clone(),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let owner: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email,display_name) values('mock@example.com','Owner') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        // Same encryption as the secret route, so the worker can decrypt the stored secret.
        let key = kernel::crypto::hmac_sha256(
            config.code_pepper.expose_secret().as_bytes(),
            &[b"webhooks.secret.aes256gcm.v1"],
        );
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let hook_with = |port: u16| {
            let id = uuid::Uuid::new_v4();
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut nonce);
            let ciphertext = cipher
                .encrypt(
                    &Nonce::from(nonce),
                    Payload {
                        msg: b"whsec_test",
                        aad: id.as_bytes(),
                    },
                )
                .unwrap();
            let mut stored = nonce.to_vec();
            stored.extend(ciphertext);
            (id, port, stored)
        };
        let (fail_port, fail_server) = one_shot_server("HTTP/1.1 500 Internal Server Error").await;
        let (ok_port, ok_server) = one_shot_server("HTTP/1.1 204 No Content").await;
        let mut hooks = Vec::new();
        for port in [fail_port, ok_port] {
            let (id, port, stored) = hook_with(port);
            sqlx::query("insert into webhooks(id,owner_id,url,events,secret_ciphertext) values($1,$2,$3,array['*'],$4)")
                .bind(id)
                .bind(owner)
                .bind(format!("http://localhost:{port}/"))
                .bind(stored)
                .execute(&db)
                .await
                .unwrap();
            hooks.push(id);
        }
        let mut tx = db.begin().await.unwrap();
        for hook in &hooks {
            enqueue_test(&mut tx, *hook).await.unwrap();
        }
        tx.commit().await.unwrap();

        let mut registry = jobs::Registry::new();
        register_jobs_with_registry(
            &mut registry,
            state,
            Arc::new(
                records::EntityRegistry::from_json(include_str!("../../../config/entities.json"))
                    .unwrap(),
            ),
        )
        .unwrap();
        let (shutdown, rx) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(jobs::run(
            db.clone(),
            registry,
            rx,
            Duration::from_secs(30),
            Duration::from_millis(10),
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let open: i64 = sqlx::query_scalar("select count(*) from jobs where kind='webhooks.delivery' and status in ('queued','running')")
                    .fetch_one(&db)
                    .await
                    .unwrap();
                if open == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        shutdown.send(true).unwrap();
        task.await.unwrap().unwrap();
        fail_server.await.unwrap();
        ok_server.await.unwrap();

        // The 500 is retried later: pending, one attempt recorded, retry scheduled.
        let retried: (String, i32, Option<i32>, bool) = sqlx::query_as(
            "select status,attempt,response_code,next_retry_at is not null from webhook_deliveries where webhook_id=$1",
        )
        .bind(hooks[0])
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(retried, ("pending".into(), 1, Some(500), true));
        // A 2xx is final: delivered, no retry scheduled.
        let delivered: (String, i32, Option<i32>, bool) = sqlx::query_as(
            "select status,attempt,response_code,next_retry_at is not null from webhook_deliveries where webhook_id=$1",
        )
        .bind(hooks[1])
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(delivered, ("delivered".into(), 1, Some(204), false));
    }
    #[test]
    fn signature_covers_exact_body() {
        assert_ne!(
            signature(b"key", "id", "1", b"{}"),
            signature(b"key", "id", "1", b"{ }")
        );
    }
}

/// Recognized event subscriptions. Record filters are restricted to entity identifiers.
pub fn valid_event(event: &str) -> bool {
    if matches!(
        event,
        "*" | "comment.created"
            | "booking.created"
            | "booking.cancelled"
            | "payment.completed"
            | "team.member_joined"
    ) {
        return true;
    }
    let (name, entity) = match event.split_once(':') {
        Some((name, entity)) => (name, Some(entity)),
        None => (event, None),
    };
    if !matches!(name, "record.created" | "record.updated" | "record.deleted") {
        return false;
    }
    entity.is_none_or(|value| {
        value == "*"
            || (!value.is_empty()
                && value.len() <= 48
                && value.as_bytes()[0].is_ascii_lowercase()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
    })
}

#[cfg(test)]
mod event_tests {
    use super::valid_event;
    #[test]
    fn event_filters_are_strict() {
        for event in [
            "*",
            "record.created",
            "record.updated:notes",
            "record.deleted:*",
            "comment.created",
        ] {
            assert!(valid_event(event), "{event}");
        }
        for event in [
            "",
            "record.created:",
            "record.created:Notes",
            "record.created:notes:other",
            "payment.completed:notes",
            "record.other",
            "record.created:../../secret",
        ] {
            assert!(!valid_event(event), "{event}");
        }
    }
}

mod routes;
pub use routes::router;

mod delivery;
pub use delivery::{register_jobs, register_jobs_with_registry};
