use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub v: Value,
    pub id: Uuid,
    pub s: String,
}
pub fn decode(s: &str, sort: &str) -> AppResult<Cursor> {
    if s.len() > 8192 {
        return Err(AppError::bad_request("Invalid cursor."));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| AppError::bad_request("Invalid cursor."))?;
    let cursor: Cursor =
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad_request("Invalid cursor."))?;
    if cursor.s != sort {
        return Err(AppError::bad_request("Invalid cursor."));
    }
    Ok(cursor)
}
pub fn encode(c: &Cursor) -> AppResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(c).map_err(AppError::internal)?))
}
