//! Privacy-preserving written-answer grading suggestions.
use std::{sync::OnceLock, time::Duration};

use axum::{
    Router,
    extract::{Path, State},
    routing::post,
};
use examcore::{AppError, AppResult, AppState, ExaminerViewer, load_exam_for_examiner};
use kernel::{
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Clone)]
struct AiConfig {
    key: String,
    base: String,
    model: String,
}

fn ai_config() -> Option<&'static AiConfig> {
    static CONFIG: OnceLock<Option<AiConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let key = std::env::var("AI_API_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty())?;
            Some(AiConfig {
                key,
                base: std::env::var("AI_BASE_URL").unwrap_or_else(|_| {
                    "https://generativelanguage.googleapis.com/v1beta/openai".into()
                }),
                model: std::env::var("AI_MODEL").unwrap_or_else(|_| "gemini-2.5-flash".into()),
            })
        })
        .as_ref()
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/attempts/{attempt_id}/answers/{item_id}/suggest",
        post(suggest),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GradingSuggestion {
    suggested_marks: f64,
    max_marks: f64,
    rationale: String,
    rubric_hits: Vec<String>,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuggestion {
    suggested_marks: f64,
    rationale: String,
    rubric_hits: Vec<String>,
}

fn clean_watermark(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}'))
        .collect()
}

fn build_prompt(stem: &str, rubric: &str, max_marks: f64, answer: &str) -> String {
    format!(
        "Question:\n{}\n\nRubric:\n{}\n\nMaximum marks: {}\n\nCandidate answer:\n{}",
        clean_watermark(stem),
        rubric,
        max_marks,
        answer.chars().take(6000).collect::<String>()
    )
}

fn parse_suggestion(raw: &str, max_marks: f64) -> AppResult<RawSuggestion> {
    // Models sometimes wrap JSON in Markdown fences; take the outermost object.
    let trimmed = raw.trim();
    let json_text = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => &trimmed[start..=end],
        _ => trimmed,
    };
    let parsed: RawSuggestion = serde_json::from_str(json_text).map_err(|error| {
        tracing::warn!(%error, "grading suggestion was not valid JSON");
        unavailable()
    })?;
    if !parsed.suggested_marks.is_finite() {
        tracing::warn!("grading suggestion had non-finite marks");
        return Err(unavailable());
    }
    // Untrusted output is bounded, not rejected: trim to the documented limits.
    let rationale: String = parsed.rationale.chars().take(600).collect();
    let rubric_hits: Vec<String> = parsed
        .rubric_hits
        .into_iter()
        .take(6)
        .map(|hit| hit.chars().take(200).collect())
        .collect();
    let marks = (parsed.suggested_marks.clamp(0.0, max_marks) * 4.0).round() / 4.0;
    Ok(RawSuggestion {
        suggested_marks: marks.min(max_marks),
        rationale,
        rubric_hits,
    })
}

fn unavailable() -> AppError {
    AppError::new(
        examcore::ErrorCode::Unavailable,
        "The grading suggestion service is unavailable.",
    )
}

async fn call_model(http: &reqwest::Client, config: &AiConfig, prompt: &str) -> AppResult<String> {
    // The free tier is sometimes overloaded (429/503): retry once, then fall back to a lighter model.
    let fallback =
        std::env::var("AI_FALLBACK_MODEL").unwrap_or_else(|_| "gemini-2.5-flash-lite".to_owned());
    let attempts = [
        config.model.as_str(),
        config.model.as_str(),
        fallback.as_str(),
    ];
    for (index, model) in attempts.iter().enumerate() {
        match call_once(http, config, model, prompt).await {
            Ok(content) => return Ok(content),
            Err(retryable) if retryable && index + 1 < attempts.len() => {
                tokio::time::sleep(Duration::from_millis(600 * (index as u64 + 1))).await;
            }
            Err(_) => break,
        }
    }
    Err(unavailable())
}

/// One model call. `Err(true)` means the failure is worth retrying (overloaded, rate limited or a network error).
async fn call_once(
    http: &reqwest::Client,
    config: &AiConfig,
    model: &str,
    prompt: &str,
) -> Result<String, bool> {
    let url = format!("{}/chat/completions", config.base.trim_end_matches('/'));
    let response = http.post(url).bearer_auth(&config.key).timeout(Duration::from_secs(20)).json(&json!({
        "model": model,
        "messages": [
            {"role":"system","content":"Act as a strict, fair examiner. Evaluate only the supplied question, rubric and candidate answer. Return only a JSON object {\"suggestedMarks\":number,\"rationale\":string (at most 600 characters),\"rubricHits\":string[] (at most 6 short items)}. Never exceed the maximum marks. Marks use 0.25 steps. Return no HTML."},
            {"role":"user","content":prompt}
        ],
        "response_format":{"type":"json_object"}
    })).send().await.map_err(|error| {
        tracing::warn!(%error, model, "grading suggestion request failed");
        true
    })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, model, "grading suggestion provider returned an error");
        return Err(status.as_u16() == 429 || status.is_server_error());
    }
    let body: Value = response.json().await.map_err(|_| false)?;
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(false)
}

async fn suggest(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path((attempt_id, item_id)): Path<(Uuid, Uuid)>,
    meta: RequestMeta,
) -> examcore::ApiJson {
    let Some(config) = ai_config() else {
        return Err(AppError::new(
            examcore::ErrorCode::NotConfigured,
            "AI grading suggestions are not configured.",
        ));
    };
    enforce_rate_limit(
        &state.db,
        &format!("ai-grading:{}", viewer.id),
        Limit {
            limit: 60,
            window: Duration::from_secs(3600),
        },
    )
    .await?;

    let row = sqlx::query("select t.exam_id,t.status,i.kind,i.stem,i.rubric,i.marks::float8 as marks,coalesce(a.response->>'text','') as answer_text from attempts t join exam_items i on i.exam_id=t.exam_id and i.id=any(t.item_order) left join answers a on a.attempt_id=t.id and a.item_id=i.id where t.id=$1 and i.id=$2")
        .bind(attempt_id).bind(item_id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let exam_id: Uuid = row.try_get("exam_id")?;
    load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    let status: String = row.try_get("status")?;
    if status == "in_progress" {
        return Err(AppError::not_found());
    }
    let kind: String = row.try_get("kind")?;
    if kind != "written" {
        return Err(examcore::invalid(
            "itemId",
            "Suggestions are available only for written answers.",
        ));
    }
    let stem: String = row.try_get("stem")?;
    let rubric: String = row.try_get("rubric")?;
    let max_marks: f64 = row.try_get("marks")?;
    let answer: String = row.try_get("answer_text")?;
    let prompt = build_prompt(&stem, &rubric, max_marks, &answer);
    let raw = call_model(&state.http, config, &prompt).await?;
    let parsed = parse_suggestion(&raw, max_marks)?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "grading.ai_suggest",
            actor_id: Some(viewer.id),
            target_type: Some("attempt"),
            target_id: Some(attempt_id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    Ok(examcore::ok(GradingSuggestion {
        suggested_marks: parsed.suggested_marks,
        max_marks,
        rationale: parsed.rationale,
        rubric_hits: parsed.rubric_hits,
        model: config.model.clone(),
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn prompt_removes_watermark_and_has_only_allowed_content() {
        let prompt = build_prompt("Question\u{200b} stem", "rubric text", 4.0, "answer text");
        assert!(prompt.contains("Question stem"));
        assert!(prompt.contains("rubric text") && prompt.contains("answer text"));
        assert!(
            !prompt.contains('\u{200b}')
                && !prompt.contains("candidate@example.com")
                && !prompt.contains("123e4567")
        );
    }

    #[test]
    fn output_is_clamped_and_bounded() {
        let got = parse_suggestion(
            r#"{"suggestedMarks":9.13,"rationale":"ok","rubricHits":["x"]}"#,
            4.0,
        )
        .expect("valid suggestion");
        assert_eq!(got.suggested_marks, 4.0);
        assert!(parse_suggestion("not json", 4.0).is_err());
        // Over-long rationale is trimmed to 600 characters rather than rejected.
        let long = parse_suggestion(
            &format!(
                r#"```json {{"suggestedMarks":1,"rationale":"{}","rubricHits":[]}} ```"#,
                "x".repeat(601)
            ),
            4.0,
        )
        .expect("fenced, long suggestion is accepted");
        assert_eq!(long.rationale.chars().count(), 600);
    }

    #[test]
    fn answer_is_truncated_to_six_thousand_chars() {
        // A character the prompt template never uses ("Maximum" contains an x).
        let prompt = build_prompt("q", "r", 1.0, &"§".repeat(7000));
        assert_eq!(prompt.matches('§').count(), 6000);
    }
}
