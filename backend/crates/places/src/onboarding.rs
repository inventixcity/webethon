//! Onboarding answers. The API accepts only the keys listed here, each with a fixed shape, so a
//! client can't use this table as free-form storage. To add a question on the day, add its key here
//! and in `ui components/src/features/onboarding/config.ts`.

use axum::extract::State;
use kernel::extract::Json;
use kernel::{
    AppResult, AppState,
    security::{Limit, enforce_rate_limit},
    viewer::Viewer,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::Duration;
use time::OffsetDateTime;

use crate::{
    model::timestamp,
    validate::{Problems, invalid},
};

const MAX_ANSWER_BYTES: usize = 16 * 1024;
const MAX_INTERESTS: usize = 12;
const NOTIFICATION_CHOICES: &[&str] = &["all", "important", "none"];
/// Saves per person per minute. Each save replaces the whole answer set.
const SAVE_LIMIT: Limit = Limit {
    limit: 60,
    window: Duration::from_secs(60),
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveInput {
    answers: Option<Value>,
    /// True once the flow is finished or skipped. Sets `completedAt` the first time only.
    completed: Option<bool>,
}

/// Answer keys look like `interests` or `goal-2`: lowercase letters, digits and hyphens.
fn is_slug(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && value.len() <= 32
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// Checks the answers against the allow-list and returns a clean copy with only known keys.
pub fn validate_answers(raw: Option<Value>) -> AppResult<Value> {
    let Some(Value::Object(map)) = raw else {
        return Err(invalid(
            json!([{ "path": "/answers", "message": "Send the answers as an object." }]),
        ));
    };
    let mut problems = Problems::default();
    let mut clean = Map::new();
    for (key, value) in map {
        match key.as_str() {
            "interests" => match interests(&value) {
                Some(list) => {
                    clean.insert(key, Value::Array(list));
                }
                None => problems.add(
                    "/answers/interests",
                    "Choose up to 12 different interests, using lowercase words.",
                ),
            },
            "notifications" => match value.as_str() {
                Some(choice) if NOTIFICATION_CHOICES.contains(&choice) => {
                    clean.insert(key, Value::String(choice.to_owned()));
                }
                _ => problems.add("/answers/notifications", "Choose all, important or none."),
            },
            // The key isn't echoed back, so a hostile name can't end up in the response.
            _ => problems.add("/answers", "This answer isn't one the app asks for."),
        }
    }
    problems.finish()?;
    let value = Value::Object(clean);
    let size = serde_json::to_vec(&value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if size > MAX_ANSWER_BYTES {
        return Err(invalid(
            json!([{ "path": "/answers", "message": "Your answers are too long." }]),
        ));
    }
    Ok(value)
}

fn interests(value: &Value) -> Option<Vec<Value>> {
    let items = value.as_array()?;
    if items.len() > MAX_INTERESTS {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let text = item.as_str()?;
        if !is_slug(text) || !seen.insert(text) {
            return None;
        }
        out.push(Value::String(text.to_owned()));
    }
    Some(out)
}

fn response(answers: Value, completed_at: Option<OffsetDateTime>) -> AppResult<Json<Value>> {
    let completed = match completed_at {
        Some(value) => Value::String(timestamp(value)?),
        None => Value::Null,
    };
    Ok(Json(
        json!({ "data": { "answers": answers, "completedAt": completed } }),
    ))
}

pub async fn read(State(state): State<AppState>, viewer: Viewer) -> AppResult<Json<Value>> {
    let row: Option<(Value, Option<OffsetDateTime>)> =
        sqlx::query_as("select answers, completed_at from onboarding_answers where user_id = $1")
            .bind(viewer.id)
            .fetch_optional(&state.db)
            .await?;
    let (answers, completed_at) = row.unwrap_or((json!({}), None));
    response(answers, completed_at)
}

pub async fn save(
    State(state): State<AppState>,
    viewer: Viewer,
    Json(input): Json<SaveInput>,
) -> AppResult<Json<Value>> {
    enforce_rate_limit(&state.db, &format!("onboarding:{}", viewer.id), SAVE_LIMIT).await?;
    let answers = validate_answers(input.answers)?;
    let completed = input.completed.unwrap_or(false);
    let (stored, completed_at): (Value, Option<OffsetDateTime>) = sqlx::query_as(
        "insert into onboarding_answers (user_id, answers, completed_at, updated_at)
         values ($1, $2, case when $3::bool then now() else null end, now())
         on conflict (user_id) do update set
             answers = excluded.answers,
             completed_at = case when $3::bool then coalesce(onboarding_answers.completed_at, now())
                                 else onboarding_answers.completed_at end,
             updated_at = now()
         returning answers, completed_at",
    )
    .bind(viewer.id)
    .bind(&answers)
    .bind(completed)
    .fetch_one(&state.db)
    .await?;
    response(stored, completed_at)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_known_answers_and_drops_nothing_valid() {
        let clean = validate_answers(Some(json!({
            "interests": ["music", "food-trucks"],
            "notifications": "important"
        })))
        .unwrap();
        assert_eq!(
            clean,
            json!({"interests": ["music", "food-trucks"], "notifications": "important"})
        );
        assert_eq!(validate_answers(Some(json!({}))).unwrap(), json!({}));
    }

    #[test]
    fn rejects_unknown_keys_and_wrong_shapes() {
        for raw in [
            json!({"role": "admin"}),
            json!({"__proto__": {}}),
            json!({"interests": "music"}),
            json!({"interests": ["Music"]}),
            json!({"interests": ["a", "a"]}),
            json!({"interests": vec!["x"; 13]}),
            json!({"interests": [1]}),
            json!({"notifications": "always"}),
            json!({"notifications": ["all"]}),
        ] {
            assert!(
                validate_answers(Some(raw.clone())).is_err(),
                "{raw} should be refused"
            );
        }
        assert!(validate_answers(None).is_err());
        assert!(validate_answers(Some(json!([]))).is_err());
    }

    #[test]
    fn refused_keys_are_not_echoed() {
        let error = validate_answers(Some(json!({"<script>": 1}))).unwrap_err();
        assert!(!error.details.unwrap().to_string().contains("script"));
    }

    #[test]
    fn slugs_are_lowercase_and_bounded() {
        assert!(is_slug("a"));
        assert!(is_slug("abc-123"));
        assert!(!is_slug(""));
        assert!(!is_slug("-a"));
        assert!(!is_slug("1a"));
        assert!(!is_slug("A"));
        assert!(!is_slug("a b"));
        assert!(!is_slug(&"a".repeat(33)));
    }
}
