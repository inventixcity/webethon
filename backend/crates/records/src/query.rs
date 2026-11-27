use crate::registry::EntityDefinition;
use kernel::{AppError, AppResult, ErrorCode};
use serde_json::Value;

pub struct ListQuery {
    pub limit: i64,
    pub sort: String,
    pub scope: String,
    pub team_id: Option<uuid::Uuid>,
    pub cursor: Option<String>,
    pub q: Option<String>,
    pub filters: Vec<(String, Value)>,
}
pub fn query_error(path: &str, message: &str) -> AppError {
    let path = path.replace('[', ".").replace(']', "");
    let path = if path.len() <= 200
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        path
    } else {
        String::new()
    };
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(serde_json::json!([{ "path": path, "message": message }]))
}
fn decode(s: &str) -> AppResult<String> {
    let mut out = Vec::new();
    let mut it = s.bytes();
    while let Some(b) = it.next() {
        match b {
            b'+' => out.push(b' '),
            b'%' => {
                let a = it
                    .next()
                    .and_then(|x| (x as char).to_digit(16))
                    .ok_or_else(|| query_error("", "Please enter a valid value."))?;
                let b = it
                    .next()
                    .and_then(|x| (x as char).to_digit(16))
                    .ok_or_else(|| query_error("", "Please enter a valid value."))?;
                out.push((a * 16 + b) as u8);
            }
            _ => out.push(b),
        }
    }
    String::from_utf8(out).map_err(|_| query_error("", "Please enter a valid value."))
}
pub fn parse(raw: Option<&str>, def: &EntityDefinition) -> AppResult<ListQuery> {
    let mut result = ListQuery {
        limit: 20,
        sort: "-createdAt".into(),
        scope: "mine".into(),
        team_id: None,
        cursor: None,
        q: None,
        filters: vec![],
    };
    let mut seen = std::collections::HashSet::new();
    for pair in raw.unwrap_or("").split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(k)?;
        let value = decode(v).map_err(|_| query_error(&key, "Please enter a valid value."))?;
        if !seen.insert(key.clone()) {
            return Err(query_error(&key, "Please enter this only once."));
        }
        match key.as_str() {
            "limit" => {
                result.limit = value
                    .parse()
                    .map_err(|_| query_error("limit", "Please enter a valid value."))?;
                if !(1..=100).contains(&result.limit) {
                    return Err(query_error("limit", "Please enter a valid value."));
                }
            }
            "sort" => result.sort = value,
            "scope" => result.scope = value,
            "teamId" => {
                result.team_id = Some(
                    uuid::Uuid::parse_str(&value)
                        .map_err(|_| query_error("teamId", "Please enter a valid value."))?,
                )
            }
            "cursor" => result.cursor = Some(value),
            "q" => {
                if value.chars().count() == 0
                    || value.chars().count() > 100
                    || def.searchable.is_empty()
                {
                    return Err(query_error("q", "Please enter a valid value."));
                }
                result.q = Some(value);
            }
            _ if key.starts_with("filter[") && key.ends_with(']') => {
                let name = &key[7..key.len() - 1];
                if !def.filterable.iter().any(|s| s == name) {
                    return Err(query_error(&key, "Please enter a valid value."));
                }
                let prop = &def.schema["properties"][name];
                let ty = &prop["type"];
                let has =
                    |s: &str| ty == s || ty.as_array().is_some_and(|a| a.iter().any(|t| t == s));
                let parsed = if has("string") {
                    Value::String(value)
                } else {
                    serde_json::from_str::<Value>(&value)
                        .map_err(|_| query_error(&key, "Please enter a valid value."))?
                };
                if !(parsed.is_string() && has("string")
                    || parsed.is_boolean() && has("boolean")
                    || parsed.is_i64() && has("integer")
                    || parsed.is_number() && has("number")
                    || parsed.is_null() && has("null"))
                {
                    return Err(query_error(&key, "Please enter a valid value."));
                }
                if prop
                    .get("enum")
                    .and_then(Value::as_array)
                    .is_some_and(|values| !values.contains(&parsed))
                {
                    return Err(query_error(&key, "Please enter a valid value."));
                }
                result.filters.push((name.into(), parsed));
            }
            _ => return Err(query_error(&key, "This field isn't allowed.")),
        }
    }
    let field = result.sort.strip_prefix('-').unwrap_or(&result.sort);
    if !matches!(field, "createdAt" | "updatedAt") && !def.sortable.iter().any(|s| s == field) {
        return Err(query_error("sort", "Please enter a valid value."));
    }
    if !matches!(result.scope.as_str(), "mine" | "public" | "all" | "team") {
        return Err(query_error("scope", "Please enter a valid value."));
    }
    if (result.scope == "team") != result.team_id.is_some() {
        return Err(query_error(
            "teamId",
            "Team ID must be used with team scope.",
        ));
    }
    Ok(result)
}
pub fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
