//! Request extractors with the API error envelope. Use `ResponseJson` for responses.
use crate::{AppError, ErrorCode};
use axum::{
    extract::{FromRequest, FromRequestParts, Request},
    http::request::Parts,
    response::{IntoResponse, Response},
};
use serde::{Serialize, de::DeserializeOwned};

/// The standard Axum JSON response type.
pub use axum::Json as ResponseJson;

/// JSON body extractor. This can also be used as a JSON response.
pub struct Json<T>(pub T);
/// Query string extractor.
pub struct Query<T>(pub T);
/// Path parameter extractor. Invalid parameters are treated as missing resources.
pub struct Path<T>(pub T);

impl<T: Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        axum::Json(self.0).into_response()
    }
}

impl<S, T> FromRequest<S> for Json<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        let content_type = req
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        let mime = content_type.split(';').next().unwrap_or_default().trim();
        let is_json = mime.eq_ignore_ascii_case("application/json")
            || mime.split_once('/').is_some_and(|(kind, subtype)| {
                kind.eq_ignore_ascii_case("application")
                    && subtype.to_ascii_lowercase().ends_with("+json")
            });
        if !is_json {
            return Err(AppError::new(
                ErrorCode::UnsupportedMediaType,
                "Please send JSON.",
            ));
        }
        let bytes = axum::body::Bytes::from_request(req, state)
            .await
            .map_err(|err| {
                if err.status().as_u16() == 413 {
                    AppError::new(ErrorCode::PayloadTooLarge, "That request is too large.")
                } else {
                    AppError::bad_request("We couldn't read that request.")
                }
            })?;
        // Check syntax separately so malformed input never becomes a field error.
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|_| AppError::bad_request("We couldn't read that request."))?;
        let mut de = serde_json::Deserializer::from_slice(&bytes);
        serde_path_to_error::deserialize(&mut de)
            .map(Self)
            .map_err(validation_error)
    }
}

impl<S, T> FromRequestParts<S> for Query<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, AppError> {
        let query = parts.uri.query().unwrap_or_default();
        let de = serde_urlencoded::Deserializer::new(url::form_urlencoded::parse(query.as_bytes()));
        serde_path_to_error::deserialize(de)
            .map(Self)
            .map_err(validation_error)
    }
}

impl<S, T> FromRequestParts<S> for Path<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        axum::extract::Path::<T>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Path(value)| Self(value))
            .map_err(|_| AppError::not_found())
    }
}

// Only return conservative field names, never serde's error text or submitted values.
fn safe_path(path: &str) -> String {
    let normalized = path.replace('[', ".").replace(']', "");
    let normalized = normalized.trim_matches('.');
    if normalized.len() <= 200
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        normalized.to_owned()
    } else {
        String::new()
    }
}
fn field_from_error<'a>(error: &'a str, prefix: &str) -> Option<&'a str> {
    error
        .strip_prefix(prefix)?
        .strip_prefix('`')?
        .split('`')
        .next()
}
fn validation_error<E: std::fmt::Display>(error: serde_path_to_error::Error<E>) -> AppError {
    let mut path = safe_path(&error.path().to_string());
    let message = error.inner().to_string();
    let (field, friendly) = if let Some(field) = field_from_error(&message, "missing field ") {
        (Some(field), "This field is required.")
    } else if let Some(field) = field_from_error(&message, "unknown field ") {
        (Some(field), "This field isn't allowed.")
    } else if message.contains("expected a string") || message.contains("expected a character") {
        (None, "Must be text.")
    } else if message.contains("expected a boolean") {
        (None, "Must be true or false.")
    } else if message.contains("expected a sequence") {
        (None, "Must be a list.")
    } else if message.contains("expected i8")
        || message.contains("expected i16")
        || message.contains("expected i32")
        || message.contains("expected i64")
        || message.contains("expected i128")
        || message.contains("expected u8")
        || message.contains("expected u16")
        || message.contains("expected u32")
        || message.contains("expected u64")
        || message.contains("expected u128")
        || message.contains("expected f32")
        || message.contains("expected f64")
        || message.contains("expected a number")
    {
        (None, "Must be a number.")
    } else {
        (None, "Please enter a valid value.")
    };
    if let Some(field) = field {
        let field = safe_path(field);
        if !field.is_empty()
            && (friendly == "This field is required."
                || (path != field && !path.ends_with(&format!(".{field}"))))
        {
            if !path.is_empty() {
                path.push('.');
            }
            path.push_str(&field);
        }
    }
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(serde_json::json!([{ "path": path, "message": friendly }]))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
        routing::{get, post},
    };
    use serde::Deserialize;
    use tower::ServiceExt;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Input {
        name: String,
        count: i64,
        active: bool,
        tags: Vec<String>,
        nested: Nested,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Nested {
        title: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Params {
        count: u32,
    }
    async fn body(Json(input): Json<Input>) -> &'static str {
        let _ = (
            input.name,
            input.count,
            input.active,
            input.tags,
            input.nested.title,
        );
        "ok"
    }
    async fn query(Query(input): Query<Params>) -> &'static str {
        let _ = input.count;
        "ok"
    }
    async fn path(Path(_id): Path<u32>) -> &'static str {
        "ok"
    }
    fn app() -> Router {
        Router::new()
            .route("/", post(body).get(query))
            .route("/{id}", get(path))
    }
    async fn call(req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let response = app().oneshot(req).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    async fn json_case(body: &str) -> (StatusCode, serde_json::Value) {
        call(
            Request::post("/")
                .header("content-type", "application/json")
                .body(Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
    }
    fn detail(value: &serde_json::Value, path: &str, message: &str) {
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        assert_eq!(
            value["error"]["message"],
            "Please check the highlighted fields."
        );
        assert_eq!(value["error"]["details"][0]["path"], path);
        assert_eq!(value["error"]["details"][0]["message"], message);
    }
    #[tokio::test]
    async fn body_errors_are_safe_and_specific() {
        let (status, value) = json_case("{").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"]["message"], "We couldn't read that request.");
        let (_, value) =
            json_case(r#"{"count":1,"active":true,"tags":[],"nested":{"title":"x"}}"#).await;
        detail(&value, "name", "This field is required.");
        let (_, value) =
            json_case(r#"{"name":"x","count":1,"active":true,"tags":[],"nested":{}}"#).await;
        detail(&value, "nested.title", "This field is required.");
        for (body, field, message) in [
            (
                r#"{"name":42,"count":1,"active":true,"tags":[],"nested":{"title":"x"}}"#,
                "name",
                "Must be text.",
            ),
            (
                r#"{"name":"x","count":"secret","active":true,"tags":[],"nested":{"title":"x"}}"#,
                "count",
                "Must be a number.",
            ),
            (
                r#"{"name":"x","count":1,"active":2,"tags":[],"nested":{"title":"x"}}"#,
                "active",
                "Must be true or false.",
            ),
            (
                r#"{"name":"x","count":1,"active":true,"tags":2,"nested":{"title":"x"}}"#,
                "tags",
                "Must be a list.",
            ),
            (
                r#"{"name":"x","count":1,"active":true,"tags":[3],"nested":{"title":"x"}}"#,
                "tags.0",
                "Must be text.",
            ),
            (
                r#"{"name":"x","count":1,"active":true,"tags":[],"nested":{"title":"x","extra":"secret"}}"#,
                "nested.extra",
                "This field isn't allowed.",
            ),
        ] {
            let (_, value) = json_case(body).await;
            detail(&value, field, message);
            assert!(!value.to_string().contains("secret"));
        }
    }
    #[tokio::test]
    async fn duplicate_and_strange_fields_are_safe() {
        let (status, value) = json_case(r#"{"name":"x","name":"secret","count":1,"active":true,"tags":[],"nested":{"title":"x"}}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(value["error"]["code"], "VALIDATION_FAILED");
        assert!(!value.to_string().contains("secret"));
        let (_, value) = json_case(r#"{"name":"x","count":1,"active":true,"tags":[],"nested":{"title":"x","secret field!":1}}"#).await;
        detail(&value, "", "This field isn't allowed.");
        assert!(!value.to_string().contains("secret"));
    }
    #[tokio::test]
    async fn query_and_path_errors_use_envelopes() {
        let (_, value) = call(Request::get("/?count=secret").body(Body::empty()).unwrap()).await;
        detail(&value, "count", "Please enter a valid value.");
        assert!(!value.to_string().contains("secret"));
        let (_, value) = call(
            Request::get("/?count=1&extra=secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        detail(&value, "extra", "This field isn't allowed.");
        let (status, value) = call(Request::get("/secret").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(value["error"]["code"], "NOT_FOUND");
    }
    #[tokio::test]
    async fn content_type_and_size_errors_keep_status() {
        let (status, value) = call(Request::post("/").body(Body::from("{}")).unwrap()).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(value["error"]["code"], "UNSUPPORTED_MEDIA_TYPE");
        let (status, value) = json_case(&format!("\"{}\"", "x".repeat(2_100_000))).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(value["error"]["code"], "PAYLOAD_TOO_LARGE");
    }
}
