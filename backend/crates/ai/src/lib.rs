//! Metered, privacy-preserving Chat Completions adapter.
pub mod config;
pub mod metering;
mod upstream;

use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use config::AiConfig;
use futures::stream;
use kernel::extract::Json as ApiJson;
use kernel::{AppError, AppResult, AppState, ErrorCode, Viewer, request::RequestMeta};
use metering::Reservation;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc};
use tokio::sync::mpsc;

pub fn router() -> Router<AppState> {
    routes().layer(axum::middleware::from_fn(load_config))
}

/// Allows the provider deadline plus a little time for admission and usage settlement.
pub fn request_timeout() -> std::time::Duration {
    config::global()
        .timeout
        .saturating_add(std::time::Duration::from_secs(5))
}

fn routes() -> Router<AppState> {
    Router::new()
        .route("/ai/chat", post(chat))
        .route("/ai/complete", post(complete))
        .route("/ai/usage", get(usage))
}

async fn load_config(mut request: Request, next: axum::middleware::Next) -> Response {
    request.extensions_mut().insert(config::global());
    next.run(request).await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Assistant,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Message {
    role: Role,
    content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Chat {
    messages: Vec<Message>,
    model: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Complete {
    prompt: String,
    #[serde(default)]
    json: bool,
}

fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path, "message": message }]))
}
fn length(value: &str, max: usize, path: &str) -> AppResult<usize> {
    let count = value.chars().count();
    if count == 0 || count > max {
        return Err(invalid(
            path,
            &format!("Use between 1 and {max} characters."),
        ));
    }
    Ok(count)
}
impl Chat {
    fn validate(&self, config: &AiConfig) -> AppResult<String> {
        if self.messages.is_empty() || self.messages.len() > 40 {
            return Err(invalid("messages", "Send between 1 and 40 messages."));
        }
        let mut total = 0;
        for (index, message) in self.messages.iter().enumerate() {
            total += length(&message.content, 8000, &format!("messages.{index}.content"))?;
        }
        if total > 48000 {
            return Err(invalid(
                "messages",
                "Use at most 48000 characters in total.",
            ));
        }
        match &self.model {
            Some(model) => {
                length(model, 256, "model")?;
                if !config.allowed.contains(model) {
                    return Err(invalid("model", "Choose an allowed model."));
                }
                Ok(model.clone())
            }
            None => Ok(config.model.clone()),
        }
    }
}

/// AppError fixes UNAVAILABLE at 503; unreadable JSON explicitly requires 502.
struct Failure {
    error: Box<AppError>,
    status: Option<StatusCode>,
}
impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self {
            error: Box::new(error),
            status: None,
        }
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let mut response = self.error.into_response();
        if let Some(status) = self.status {
            *response.status_mut() = status;
        }
        response
    }
}
fn unavailable() -> AppError {
    AppError::new(ErrorCode::Unavailable, "The AI is busy. Please try again.")
}
fn event(name: &str, value: Value) -> String {
    format!("event: {name}\ndata: {value}\n\n")
}

async fn chat(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Extension(config): Extension<Arc<AiConfig>>,
    ApiJson(body): ApiJson<Chat>,
) -> Result<Response, Failure> {
    config.ready()?;
    let model = body.validate(&config)?;
    let (request, input) = upstream::request_body(&config, &model, &body.messages, false);
    let mut reservation =
        Reservation::reserve(&state.db, viewer.id, meta, input, &config, &model).await?;
    let started = std::time::Instant::now();
    let response = upstream::connect(&state.http, &config, request).await?;
    let (sender, receiver) = mpsc::channel::<String>(8);
    tokio::spawn(async move {
        // closed() also interrupts reads while the upstream stalls and sends while the client stalls.
        let result = tokio::select! {
            biased;
            () = sender.closed() => Err(unavailable()),
            result = tokio::time::timeout(config.timeout.saturating_sub(started.elapsed()), upstream::consume(response, &mut reservation, Some(&sender))) => result.unwrap_or_else(|_| Err(unavailable())),
        };
        let usage = reservation.usage();
        reservation.finish().await;
        let terminal = match result {
            Ok(output) => event(
                "done",
                json!({"usage": usage, "finishReason": output.finish_reason}),
            ),
            Err(error) => event(
                "error",
                json!({"code": error.code, "message": error.message}),
            ),
        };
        let _ = sender.send(terminal).await;
    });
    let stream = stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|item| (Ok::<_, Infallible>(item), receiver))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
            (
                axum::http::HeaderName::from_static("x-accel-buffering"),
                "no",
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

async fn complete(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Extension(config): Extension<Arc<AiConfig>>,
    ApiJson(body): ApiJson<Complete>,
) -> Result<Json<Value>, Failure> {
    config.ready()?;
    length(&body.prompt, 16000, "prompt")?;
    let messages = vec![Message {
        role: Role::User,
        content: body.prompt,
    }];
    let (request, input) = upstream::request_body(&config, &config.model, &messages, body.json);
    let mut reservation =
        Reservation::reserve(&state.db, viewer.id, meta, input, &config, &config.model).await?;
    let result = tokio::time::timeout(config.timeout, async {
        let response = upstream::connect(&state.http, &config, request).await?;
        upstream::consume(response, &mut reservation, None)
            .await
            .map_err(Failure::from)
    })
    .await
    .unwrap_or_else(|_| Err(unavailable().into()));
    let usage = reservation.usage();
    reservation.finish().await;
    let output = result?;
    let mut data = json!({"text": output.text, "usage": usage});
    if body.json {
        let parsed = serde_json::from_str::<Value>(&output.text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| Failure {
                error: Box::new(AppError::new(
                    ErrorCode::Unavailable,
                    "The AI returned something unreadable. Try again.",
                )),
                status: Some(StatusCode::BAD_GATEWAY),
            })?;
        data["json"] = parsed;
    }
    Ok(Json(json!({"data": data})))
}

async fn usage(
    State(state): State<AppState>,
    _viewer: Viewer,
    Extension(config): Extension<Arc<AiConfig>>,
) -> AppResult<Json<Value>> {
    config.ready()?;
    let day = time::OffsetDateTime::now_utc().date();
    let (requests, input, output): (i32, i64, i64) = sqlx::query_as("select requests, input_tokens, output_tokens from ai_usage where user_id = $1 and day = $2")
        .bind(_viewer.id).bind(day).fetch_optional(&state.db).await?.unwrap_or((0, 0, 0));
    Ok(Json(
        json!({"data": {"day": day.to_string(), "requests": requests, "inputTokens": input, "outputTokens": output, "dailyLimit": config.daily}}),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod extractor_rejection_tests {
    use super::*;
    use axum::extract::FromRequest;
    #[tokio::test]
    async fn dto_rejections_use_shared_errors() {
        for (body, code, path) in [
            ("{", kernel::ErrorCode::BadRequest, ""),
            ("{}", kernel::ErrorCode::ValidationFailed, "prompt"),
            (
                "{\"prompt\":1}",
                kernel::ErrorCode::ValidationFailed,
                "prompt",
            ),
            (
                "{\"prompt\":\"x\",\"extra\":1}",
                kernel::ErrorCode::ValidationFailed,
                "extra",
            ),
        ] {
            let request = axum::http::Request::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            let error =
                match <ApiJson<Complete> as FromRequest<()>>::from_request(request, &()).await {
                    Ok(_) => panic!("invalid input accepted"),
                    Err(error) => error,
                };
            assert_eq!(error.code, code);
            if !path.is_empty() {
                assert_eq!(error.details.unwrap()[0]["path"], path);
            }
        }
    }
}
