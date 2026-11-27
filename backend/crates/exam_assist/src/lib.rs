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
    let parsed: RawSuggestion = serde_json::from_str(raw).map_err(|_| unavailable())?;
    if !parsed.suggested_marks.is_finite()
        || parsed.rationale.chars().count() > 600
        || parsed.rubric_hits.len() > 6
        || parsed.rubric_hits.iter().any(|s| s.chars().count() > 200)
    {
        return Err(unavailable());
    }
    let marks = (parsed.suggested_marks.clamp(0.0, max_marks) * 4.0).round() / 4.0;
    Ok(RawSuggestion {
        suggested_marks: marks.min(max_marks),
        rationale: parsed.rationale,
        rubric_hits: parsed.rubric_hits,
    })
}

fn unavailable() -> AppError {
    AppError::new(
        examcore::ErrorCode::Unavailable,
        "The grading suggestion service is unavailable.",
    )
}

async fn call_model(http: &reqwest::Client, config: &AiConfig, prompt: &str) -> AppResult<String> {
    let url = format!("{}/chat/completions", config.base.trim_end_matches('/'));
    let response = http.post(url).bearer_auth(&config.key).timeout(Duration::from_secs(20)).json(&json!({
        "model": config.model,
        "messages": [
            {"role":"system","content":"Act as a strict, fair examiner. Evaluate only the supplied question, rubric and candidate answer. Return JSON {suggestedMarks:number,rationale:string (<=600 chars),rubricHits:string[] (<=6)}. Never exceed maximum marks. Marks must use 0.25 steps. Return no HTML."},
            {"role":"user","content":prompt}
        ],
        "response_format":{"type":"json_object"}
    })).send().await.map_err(|_| unavailable())?.error_for_status().map_err(|_| unavailable())?;
    let body: Value = response.json().await.map_err(|_| unavailable())?;
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(unavailable)
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
        assert!(
            parse_suggestion(
                &format!(
                    r#"{{"suggestedMarks":1,"rationale":"{}","rubricHits":[]}}"#,
                    "x".repeat(601)
                ),
                4.0
            )
            .is_err()
        );
    }

    #[test]
    fn answer_is_truncated_to_six_thousand_chars() {
        // A character the prompt template never uses ("Maximum" contains an x).
        let prompt = build_prompt("q", "r", 1.0, &"§".repeat(7000));
        assert_eq!(prompt.matches('§').count(), 6000);
    }
}
