mod telemetry;

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{ConnectInfo, MatchedPath, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::BytesMut;
use futures::StreamExt;
use kernel::{
    AppError, AppState, ErrorCode,
    request::{REQUEST_ID, client_ip, request_id_from},
    security::{self, limits},
    session,
};
use tower_http::{
    catch_panic::CatchPanicLayer,
    sensitive_headers::{SetSensitiveRequestHeadersLayer, SetSensitiveResponseHeadersLayer},
};

/// The largest upload body accepted on POST /api/v1/files (the Vercel proxy caps requests at 4.5 MB).
const UPLOAD_BODY_BYTES: usize = 4 * 1024 * 1024 + 64 * 1024;
const API_ERROR_BODY_BYTES: usize = 64 * 1024;

pub fn build_app(
    state: AppState,
    registry: Arc<records::EntityRegistry>,
    storage: Arc<dyn files::Storage>,
    hub: realtime::Hub,
) -> Router {
    finish_router(build_router(registry), state, storage, hub)
}

pub fn build_router(registry: Arc<records::EntityRegistry>) -> Router<AppState> {
    let api = exam_questions::router()
        .merge(exam_authoring::router())
        .merge(exam_enroll::router())
        .merge(exam_grading::router())
        .merge(exam_attempts::router())
        .merge(exam_resilience::router())
        .merge(exam_integrity::router())
        .merge(exam_analytics::router())
        .merge(ai::router())
        // Optional AI grading suggestions remain available; unused product routers are not mounted.
        .layer(Extension(registry));
    // Browsers use the same-origin proxy. For other origins, add tower_http::cors with
    // an explicit allowlist; never combine wildcard origins with credentials.
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/readyz", get(ready))
        .route("/api/v1/health", get(api_ready))
        .nest("/api/v1/auth", auth::router())
        .nest("/api/v1/admin", admin::router())
        .nest("/api/v1", api)
        .fallback(|| async { AppError::not_found() })
        .method_not_allowed_fallback(|| async {
            AppError::new(
                ErrorCode::MethodNotAllowed,
                "That method isn't allowed here.",
            )
        })
}

pub fn finish_router(
    router: Router<AppState>,
    state: AppState,
    storage: Arc<dyn files::Storage>,
    hub: realtime::Hub,
) -> Router {
    let collector = telemetry::Collector::start(state.db.clone());
    router
        .route_layer(middleware::from_fn(record_route))
        .layer(CatchPanicLayer::custom(|_| {
            AppError::internal("request panicked").into_response()
        }))
        .layer(middleware::from_fn_with_state(state.clone(), process))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            refresh_cookie,
        ))
        .layer(CatchPanicLayer::custom(|_| {
            AppError::internal("request panicked").into_response()
        }))
        .layer(middleware::from_fn_with_state(collector, observe))
        .layer(SetSensitiveResponseHeadersLayer::new([header::SET_COOKIE]))
        .layer(SetSensitiveRequestHeadersLayer::new([
            header::AUTHORIZATION,
            header::COOKIE,
            header::PROXY_AUTHORIZATION,
            axum::http::HeaderName::from_static("x-client-ip-signature"),
        ]))
        .layer(Extension(storage))
        .layer(Extension(hub))
        .with_state(state)
}

async fn refresh_cookie(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let refresh = session::CookieRefresh::default();
    request.extensions_mut().insert(refresh.clone());
    let mut response = next.run(request).await;
    if let Some(cookie) = refresh.take() {
        let explicit = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|value| value.split_once('='))
                    .is_some_and(|(name, _)| name.trim() == state.config.session_cookie)
            });
        if !explicit {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
    }
    response
}

#[derive(Clone, Default)]
struct RouteLabel(Arc<Mutex<Option<String>>>);

async fn record_route(request: Request, next: Next) -> Response {
    if let (Some(label), Some(path)) = (
        request.extensions().get::<RouteLabel>(),
        request.extensions().get::<MatchedPath>(),
    ) && let Ok(mut route) = label.0.lock()
    {
        *route = Some(path.as_str().to_owned());
    }
    next.run(request).await
}

async fn ready(State(state): State<AppState>) -> Response {
    if matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            sqlx::query("select 1").execute(&state.db)
        )
        .await,
        Ok(Ok(_))
    ) {
        Json(serde_json::json!({"status":"ok"})).into_response()
    } else {
        AppError::new(ErrorCode::Unavailable, "The service is not ready.")
            .retry_after(2)
            .into_response()
    }
}
async fn api_ready(State(state): State<AppState>) -> Response {
    let response = ready(State(state)).await;
    if response.status().is_success() {
        Json(serde_json::json!({"data":{"status":"ok"}})).into_response()
    } else {
        response
    }
}

async fn observe(
    State(collector): State<telemetry::Collector>,
    mut request: Request,
    next: Next,
) -> Response {
    let is_api =
        request.uri().path().starts_with("/api/v1/") && request.uri().path() != "/api/v1/health";
    let method = request.method().clone();
    let label = RouteLabel::default();
    request.extensions_mut().insert(label.clone());
    let response = next.run(request).await;
    if is_api {
        let route = label
            .0
            .lock()
            .ok()
            .and_then(|route| route.clone())
            .unwrap_or_else(|| "<unmatched>".to_owned());
        collector.record(&method, route, response.status().as_u16());
    }
    response
}

async fn process(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let id = request_id_from(request.headers());
    let label = request
        .extensions()
        .get::<RouteLabel>()
        .cloned()
        .unwrap_or_default();
    REQUEST_ID.scope(id.clone(), async move {
        let method = request.method().clone();
        let started = Instant::now();
        // AI has a configured provider deadline; the ordinary 15s guard must not cut it short.
        let timeout = if method == Method::POST && matches!(request.uri().path(), "/api/v1/ai/chat" | "/api/v1/ai/complete" | "/api/v1/assist/ask") {
            state.config.request_timeout.max(ai::request_timeout())
        } else {
            state.config.request_timeout
        };
        let mut response = match tokio::time::timeout(timeout, guarded(&state, request, next)).await {
            Ok(response) => response,
            Err(_) => AppError::new(ErrorCode::Unavailable, "The request took too long. Please try again.").retry_after(2).into_response(),
        };
        let route = label.0.lock().ok().and_then(|route| route.clone()).unwrap_or_else(|| "<unmatched>".to_owned());
        let status = response.status();
        tracing::info!(%method, path = %route, %status, latency_ms = started.elapsed().as_millis(), request_id = %id, "request");
        metrics::counter!("http_requests_total", "method" => method.to_string(), "route" => route.clone(), "status" => status.as_u16().to_string()).increment(1);
        metrics::histogram!("http_request_duration_seconds", "method" => method.to_string(), "route" => route, "status" => status.as_u16().to_string()).record(started.elapsed().as_secs_f64());
        metrics::gauge!("db_pool_size").set(f64::from(state.db.size()));
        let idle = state.db.num_idle();
        metrics::gauge!("db_pool_idle").set(idle as f64);
        metrics::gauge!("db_pool_inuse").set((state.db.size() as usize).saturating_sub(idle) as f64);
        let headers = response.headers_mut();
        if let Ok(value) = HeaderValue::from_str(&id) { headers.insert("x-request-id", value); }
        // Handlers may set a stricter or more specific cache policy and CSP (file downloads do); keep theirs.
        for (name, value) in [("cache-control", "no-store"), ("content-security-policy", "default-src 'none'; frame-ancestors 'none'")] {
            headers.entry(name).or_insert(HeaderValue::from_static(value));
        }
        for (name, value) in [("x-content-type-options", "nosniff"), ("referrer-policy", "no-referrer"), ("x-frame-options", "DENY"), ("cross-origin-resource-policy", "same-origin")] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        if state.config.is_production() { headers.insert("strict-transport-security", HeaderValue::from_static("max-age=63072000; includeSubDomains")); }
        response
    }).await
}

async fn guarded(state: &AppState, mut request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let headers = request.headers();
    let cookie = session::read_cookie(headers, &state.config.session_cookie);
    if matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && cookie.is_some()
        && !headers.contains_key(header::AUTHORIZATION)
        && !security::passes_origin_check(&state.config, &method, headers)
    {
        return AppError::new(
            ErrorCode::CsrfRejected,
            "Please refresh the page and try again.",
        )
        .into_response();
    }
    // Health probes must remain usable when the database is unavailable.
    if request.uri().path() != "/healthz" && request.uri().path() != "/readyz" {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|v| v.0);
        // Keyed on the trusted client IP, never on a token the caller sends: unverified token strings
        // would let anyone mint a fresh budget (and a new row) per request. Per-user limits live in
        // the feature crates, after authentication.
        let subject = format!("ip:{}", client_ip(state, headers, peer));
        let read = matches!(method, Method::GET | Method::HEAD);
        let budget = if read {
            limits::API_READ_PER_SUBJECT
        } else {
            limits::API_WRITE_PER_SUBJECT
        };
        let rate = match security::rate_limit_hit(
            &state.db,
            &format!("api:{}:{subject}", if read { "read" } else { "write" }),
            budget,
        )
        .await
        {
            Ok(rate) => rate,
            Err(_) => {
                return AppError::new(
                    ErrorCode::Unavailable,
                    "The service is busy. Please try again.",
                )
                .retry_after(2)
                .into_response();
            }
        };
        if !rate.allowed {
            let wait = (rate.reset_at - time::OffsetDateTime::now_utc())
                .whole_seconds()
                .max(1) as u64;
            return AppError::new(
                ErrorCode::RateLimited,
                "Too many requests. Please try again shortly.",
            )
            .retry_after(wait)
            .into_response();
        }
        request.extensions_mut().insert(Remaining(rate.remaining));
    }
    let remaining = request.extensions().get::<Remaining>().map(|v| v.0);
    let upload = method == Method::POST
        && (request.uri().path() == "/api/v1/files" || is_import_path(request.uri().path()));
    if method == Method::POST && is_import_path(request.uri().path()) {
        let multipart = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("multipart/form-data"));
        if !multipart {
            return AppError::new(
                ErrorCode::UnsupportedMediaType,
                "Please send multipart form data.",
            )
            .into_response();
        }
    }
    let limit = if upload {
        UPLOAD_BODY_BYTES
    } else {
        state.config.max_body_bytes
    };
    let (parts, body) = request.into_parts();
    let mut stream = body.into_data_stream();
    let mut bytes = BytesMut::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                return AppError::bad_request("Could not read the request body.").into_response();
            }
        };
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return AppError::new(ErrorCode::PayloadTooLarge, "The request is too large.")
                .into_response();
        }
        bytes.extend_from_slice(&chunk);
    }
    let bytes = bytes.freeze();
    // Uploads are multipart; the files crate checks their type itself, by magic bytes.
    if matches!(method, Method::POST | Method::PUT | Method::PATCH) && !bytes.is_empty() && !upload
    {
        let content_type = parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let mut components = content_type.split(';');
        let valid = components
            .next()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            && components.all(|v| v.trim().eq_ignore_ascii_case("charset=utf-8"));
        if !valid {
            return AppError::new(ErrorCode::UnsupportedMediaType, "Please send JSON.")
                .into_response();
        }
        if too_deep(&bytes) {
            return AppError::bad_request("JSON is nested too deeply.").into_response();
        }
    }
    let path = parts.uri.path().to_owned();
    let mut response = next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await;
    response = normalize_contract_error(&path, response).await;
    if matches!(
        response.status(),
        StatusCode::BAD_REQUEST
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) && response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/plain"))
    {
        response = AppError::bad_request("Please check your request.").into_response();
    }
    if let Some(remaining) = remaining
        && let Ok(value) = HeaderValue::from_str(&remaining.to_string())
    {
        response.headers_mut().insert("ratelimit-remaining", value);
    }
    response
}

async fn normalize_contract_error(path: &str, response: Response) -> Response {
    let status = response.status();
    if !(path.starts_with("/api/v1/")
        && matches!(status, StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN))
    {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, API_ERROR_BODY_BYTES).await else {
        return AppError::internal("Could not read the API error response.").into_response();
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Response::from_parts(parts, Body::from(bytes)),
    };
    let error_code = value
        .pointer("/error/code")
        .and_then(serde_json::Value::as_str);
    let Some(contract_status) = contract_error_status(path, status, error_code) else {
        return Response::from_parts(parts, Body::from(bytes));
    };

    parts.status = contract_status;
    Response::from_parts(parts, Body::from(bytes))
}

fn contract_error_status(
    path: &str,
    status: StatusCode,
    error_code: Option<&str>,
) -> Option<StatusCode> {
    if status == StatusCode::BAD_REQUEST && error_code == Some("VALIDATION_FAILED") {
        return Some(StatusCode::UNPROCESSABLE_ENTITY);
    }

    if status == StatusCode::FORBIDDEN && is_examiner_only_path(path) {
        return Some(StatusCode::NOT_FOUND);
    }

    None
}

fn is_examiner_only_path(path: &str) -> bool {
    ["/api/v1/questions", "/api/v1/exams"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
        || path.starts_with("/api/v1/attempts/")
            && (path.ends_with("/grade")
                || path.ends_with("/integrity")
                || path.ends_with("/outages"))
}

fn is_import_path(path: &str) -> bool {
    let mut parts = path.split('/');
    matches!((parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(""), Some("api"), Some("v1"), Some("entities"), Some(entity), Some("import"), None) if !entity.is_empty())
}
#[derive(Clone)]
struct Remaining(i32);
fn too_deep(bytes: &[u8]) -> bool {
    let (mut depth, mut string, mut escaped) = (0usize, false, false);
    for &b in bytes {
        if string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                string = false;
            }
        } else {
            match b {
                b'"' => string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 32 {
                        return true;
                    }
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{contract_error_status, is_import_path, too_deep};
    use axum::http::StatusCode;

    #[test]
    fn validation_errors_use_unprocessable_status() {
        assert_eq!(
            contract_error_status(
                "/api/v1/questions",
                StatusCode::BAD_REQUEST,
                Some("VALIDATION_FAILED"),
            ),
            Some(StatusCode::UNPROCESSABLE_ENTITY)
        );
        assert_eq!(
            contract_error_status(
                "/api/v1/questions",
                StatusCode::BAD_REQUEST,
                Some("BAD_REQUEST"),
            ),
            None
        );
    }

    #[test]
    fn examiner_only_denials_hide_resource_existence() {
        for path in [
            "/api/v1/questions",
            "/api/v1/questions/00000000-0000-0000-0000-000000000001",
            "/api/v1/exams/00000000-0000-0000-0000-000000000001/grading",
            "/api/v1/attempts/00000000-0000-0000-0000-000000000001/answers/00000000-0000-0000-0000-000000000002/grade",
            "/api/v1/attempts/00000000-0000-0000-0000-000000000001/integrity",
            "/api/v1/attempts/00000000-0000-0000-0000-000000000001/outages",
        ] {
            assert_eq!(
                contract_error_status(path, StatusCode::FORBIDDEN, Some("FORBIDDEN")),
                Some(StatusCode::NOT_FOUND),
                "path {path}"
            );
        }
        assert_eq!(
            contract_error_status(
                "/api/v1/admin/users",
                StatusCode::FORBIDDEN,
                Some("FORBIDDEN"),
            ),
            None
        );
    }

    #[test]
    fn import_path_is_exact() {
        assert!(is_import_path("/api/v1/entities/books/import"));
        for path in [
            "/api/v1/entities//import",
            "/api/v1/entities/books/import/extra",
            "/api/v1/entities/books/import/",
            "/api/v1/entities/import",
        ] {
            assert!(!is_import_path(path));
        }
    }
    #[test]
    fn nesting_ignores_strings_and_escapes() {
        assert!(!too_deep(br#"{"value":"[[[\\\"{"}"#));
        assert!(!too_deep(
            format!("{}0{}", "[".repeat(32), "]".repeat(32)).as_bytes()
        ));
        assert!(too_deep(
            format!("{}0{}", "[".repeat(33), "]".repeat(33)).as_bytes()
        ));
    }
}
