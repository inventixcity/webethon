//! Database rows and the JSON shape clients see. Owner ids are never sent; `mine` says whether the
//! place belongs to the person asking.

use kernel::{AppError, AppResult};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

/// Every column the API returns, in the order `PlaceRow` reads them.
pub const COLUMNS: &str = "id, owner_id, name, description, lat, lng, address, category, visibility, admin_hidden_at, created_at, updated_at";

#[derive(Debug, sqlx::FromRow)]
pub struct PlaceRow {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: String,
    pub lat: f64,
    pub lng: f64,
    pub address: String,
    pub category: String,
    pub visibility: String,
    pub admin_hidden_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

/// A place plus its distance from the search point, from the radius query.
#[derive(Debug, sqlx::FromRow)]
pub struct NearbyRow {
    #[sqlx(flatten)]
    pub place: PlaceRow,
    pub meters: f64,
}

pub fn timestamp(value: OffsetDateTime) -> AppResult<String> {
    value.format(&Rfc3339).map_err(AppError::internal)
}

pub fn place_json(row: &PlaceRow, viewer: Option<Uuid>) -> AppResult<Value> {
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "lat": row.lat,
        "lng": row.lng,
        "address": row.address,
        "category": row.category,
        "visibility": row.visibility,
        "mine": viewer == Some(row.owner_id),
        "moderationHidden": row.admin_hidden_at.is_some(),
        "createdAt": timestamp(row.created_at)?,
        "updatedAt": timestamp(row.updated_at)?,
    }))
}

pub fn nearby_json(row: &NearbyRow, viewer: Option<Uuid>) -> AppResult<Value> {
    let mut value = place_json(&row.place, viewer)?;
    if let Some(object) = value.as_object_mut() {
        // Whole metres are precise enough for a map and keep the payload small.
        object.insert("distanceM".into(), json!(row.meters.round()));
    }
    Ok(value)
}
