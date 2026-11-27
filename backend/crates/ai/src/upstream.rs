use crate::{
    Failure, Message,
    config::AiConfig,
    event,
    metering::{Reservation, Usage},
    unavailable,
};
use futures::StreamExt;
use kernel::{AppError, AppResult, ErrorCode};
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use tokio::sync::mpsc;

const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn request_body(
    config: &AiConfig,
    model: &str,
    messages: &[Message],
    json_mode: bool,
) -> (Value, i64) {
    let mut all = vec![json!({"role": "system", "content": config.system})];
    let mut chars = config.system.chars().count();
    for message in messages {
        chars += message.content.chars().count();
        all.push(json!(message));
    }
    // JSON mode needs an explicit JSON instruction for compatible providers that require one.
    if json_mode {
        all.push(json!({"role": "system", "content": "Return only a valid JSON object."}));
        chars += 32;
    }
    let mut body = json!({"model": model, "messages": all, "stream": true, "max_tokens": config.max_output, "stream_options": {"include_usage": true}});
    if json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }
    (body, (chars as i64 + 2) / 3)
}

pub(super) async fn connect(
    client: &reqwest::Client,
    config: &AiConfig,
    body: Value,
) -> Result<reqwest::Response, Failure> {
    let key = config
        .key
        .as_ref()
        .ok_or_else(|| AppError::new(ErrorCode::NotConfigured, "AI isn't configured yet."))?;
    // Do not log reqwest errors: URLs and provider error payloads may contain secrets.
    let response = client
        .post(format!(
            "{}/chat/completions",
            config.base.trim_end_matches('/')
        ))
        .bearer_auth(key.expose_secret())
        .header("accept", "text/event-stream")
        .timeout(config.timeout)
        .json(&body)
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let retry = retry_delay(response.headers().get("retry-after"));
    let error = match status.as_u16() {
        401 | 403 => {
            tracing::error!(
                status = status.as_u16(),
                "AI upstream authentication rejected; check server configuration"
            );
            AppError::new(ErrorCode::NotConfigured, "AI isn't configured yet.")
        }
        429 => AppError::new(
            ErrorCode::RateLimited,
            "The AI is busy. Please wait a little and try again.",
        )
        .retry_after(retry),
        _ => unavailable(),
    };
    Err(Failure {
        error: Box::new(error),
        status: None,
    })
}

fn retry_delay(value: Option<&reqwest::header::HeaderValue>) -> u64 {
    value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(15)
        .clamp(1, 300)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod retry_tests {
    use super::*;

    #[test]
    fn retry_delay_is_numeric_and_bounded() {
        for (value, expected) in [
            (None, 15),
            (Some("17"), 17),
            (Some("0"), 1),
            (Some("999999"), 300),
            (Some("invalid provider text"), 15),
            (Some("999999999999999999999999999999"), 15),
        ] {
            let header = value.map(|v| reqwest::header::HeaderValue::from_str(v).unwrap());
            assert_eq!(retry_delay(header.as_ref()), expected);
        }
    }
}

#[derive(Default)]
pub(super) struct Output {
    pub text: String,
    pub finish_reason: Option<String>,
}

/// Byte buffering preserves UTF-8 split across HTTP chunks. SSE event data may span several lines.
#[derive(Default)]
struct Decoder {
    line: Vec<u8>,
    data: Vec<u8>,
    total: usize,
}
impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> AppResult<Vec<Vec<u8>>> {
        self.total = self.total.saturating_add(bytes.len());
        if self.total > MAX_BYTES {
            return Err(unavailable());
        }
        let mut events = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                let line = self.line.strip_suffix(b"\r").unwrap_or(&self.line);
                if line.is_empty() {
                    if !self.data.is_empty() {
                        events.push(std::mem::take(&mut self.data));
                    }
                } else if let Some(data) = line.strip_prefix(b"data:") {
                    if !self.data.is_empty() {
                        self.data.push(b'\n');
                    }
                    self.data
                        .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                }
                self.line.clear();
            } else {
                self.line.push(*byte);
            }
        }
        Ok(events)
    }
}

pub(super) async fn consume(
    response: reqwest::Response,
    reservation: &mut Reservation,
    sender: Option<&mpsc::Sender<String>>,
) -> AppResult<Output> {
    let mut body = response.bytes_stream();
    let mut decoder = Decoder::default();
    let mut output = Output::default();
    while let Some(chunk) = body.next().await {
        for data in decoder.push(&chunk.map_err(|_| unavailable())?)? {
            if data == b"[DONE]" {
                return Ok(output);
            }
            let value: Value = serde_json::from_slice(&data).map_err(|_| unavailable())?;
            if value.get("error").is_some() {
                return Err(unavailable());
            }
            if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
                let input = usage
                    .get("prompt_tokens")
                    .and_then(Value::as_i64)
                    .filter(|v| (0..=1_000_000_000).contains(v))
                    .ok_or_else(unavailable)?;
                let output = usage
                    .get("completion_tokens")
                    .and_then(Value::as_i64)
                    .filter(|v| (0..=1_000_000_000).contains(v))
                    .ok_or_else(unavailable)?;
                reservation.set_usage(Usage { input, output });
            }
            let choices = value
                .get("choices")
                .and_then(Value::as_array)
                .ok_or_else(unavailable)?;
            for choice in choices {
                if choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                    continue;
                }
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    output.finish_reason = Some(
                        match reason {
                            "stop" | "length" | "content_filter" | "tool_calls"
                            | "function_call" => reason,
                            _ => "unknown",
                        }
                        .to_owned(),
                    );
                }
                if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
                    if output.text.len().saturating_add(text.len()) > MAX_BYTES {
                        return Err(unavailable());
                    }
                    if let Some(sender) = sender {
                        sender
                            .send(event("delta", json!({"text": text})))
                            .await
                            .map_err(|_| unavailable())?;
                    } else {
                        output.text.push_str(text);
                    }
                }
            }
        }
    }
    // A missing DONE or partial final event signals a truncated upstream response.
    Err(unavailable())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn decoder_handles_utf8_crlf_comments_and_multiline() {
        let mut decoder = Decoder::default();
        let bytes = ": keepalive\r\ndata: hÃƒÆ’Ã‚Â©\r\ndata: next\r\n\r\n".as_bytes();
        let split = bytes.iter().position(|b| *b == 0xc3).unwrap() + 1;
        assert!(decoder.push(&bytes[..split]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&bytes[split..]).unwrap(),
            vec!["hÃƒÆ’Ã‚Â©\nnext".as_bytes()]
        );
    }
    #[test]
    fn decoder_caps_memory() {
        assert!(Decoder::default().push(&vec![b'x'; MAX_BYTES + 1]).is_err());
    }
}
