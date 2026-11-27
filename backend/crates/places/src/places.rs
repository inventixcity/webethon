//! Place CRUD and map searches. Access rule: a private place is visible only to its owner, a public
//! one to everyone. Anything a person can't see, or can't change, answers 404 so existence isn't revealed.

use axum::{
    extract::{RawQuery, State},
    http::StatusCode,
};
use kernel::extract::Json;
use kernel::extract::Path;
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    request::RequestMeta,
    security::{AuditEntry, audit},
    viewer::Viewer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    model::{COLUMNS, NearbyRow, PlaceRow, nearby_json, place_json},
    validate::{self, LngRange, Problems, invalid},
};

/// Hard cap on places per owner. Stops one account from filling the table.
pub const MAX_PLACES_PER_OWNER: i64 = 500;
const DEFAULT_LIST_LIMIT: i64 = 200;
/// Matches the spec: a map view never returns more than this many places.
const MAX_LIST_LIMIT: i64 = 500;
const DEFAULT_NEARBY_LIMIT: i64 = 20;
const MAX_NEARBY_LIMIT: i64 = 100;
const DEFAULT_RADIUS_KM: f64 = 5.0;
const MIN_RADIUS_KM: f64 = 0.001;
const MAX_RADIUS_KM: f64 = 50.0;

/// The fields a client may send. Every field is optional so that PATCH can change a few; creating
/// checks that the required ones are present.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteInput {
    name: Option<String>,
    description: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    address: Option<String>,
    category: Option<String>,
    visibility: Option<String>,
}

/// A checked, complete set of field values ready to store.
struct Draft {
    name: String,
    description: String,
    lat: f64,
    lng: f64,
    address: String,
    category: String,
    visibility: String,
}

impl Draft {
    /// For a create, `base` is `None` and the required fields must be sent. For an update, `base` is
    /// the stored row and any field that's missing keeps its stored value.
    fn from_input(input: WriteInput, base: Option<&PlaceRow>) -> AppResult<Self> {
        let mut problems = Problems::default();
        let name = match input.name {
            Some(raw) => validate::text(&mut problems, "/name", &raw, 120, false),
            None => base.map(|row| row.name.clone()).unwrap_or_default(),
        };
        if name.is_empty() {
            problems.add("/name", "Please add a name.");
        }
        let description = match input.description {
            Some(raw) => validate::text(&mut problems, "/description", &raw, 2000, true),
            None => base.map(|row| row.description.clone()).unwrap_or_default(),
        };
        let address = match input.address {
            Some(raw) => validate::text(&mut problems, "/address", &raw, 300, false),
            None => base.map(|row| row.address.clone()).unwrap_or_default(),
        };
        let category = match input.category {
            Some(raw) => validate::category(&mut problems, &raw),
            None => base.map(|row| row.category.clone()).unwrap_or_default(),
        };
        let visibility = match input.visibility {
            Some(raw) => validate::visibility(&mut problems, &raw),
            None => base
                .map(|row| row.visibility.clone())
                .unwrap_or_else(|| "private".to_owned()),
        };
        let lat = match (input.lat, base) {
            (Some(value), _) => {
                validate::latitude(&mut problems, "/lat", value);
                value
            }
            (None, Some(row)) => row.lat,
            (None, None) => {
                problems.add("/lat", "Please add a latitude.");
                0.0
            }
        };
        let lng = match (input.lng, base) {
            (Some(value), _) => {
                validate::longitude(&mut problems, "/lng", value);
                value
            }
            (None, Some(row)) => row.lng,
            (None, None) => {
                problems.add("/lng", "Please add a longitude.");
                0.0
            }
        };
        problems.finish()?;
        Ok(Self {
            name,
            description,
            lat,
            lng,
            address,
            category,
            visibility,
        })
    }
}

fn parse_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found())
}

/// Visible to this viewer: their own place, or any public one. Deleted rows never match.
async fn fetch_visible(db: &PgPool, id: Uuid, viewer: Option<Uuid>) -> AppResult<PlaceRow> {
    sqlx::query_as(&format!(
        "select {COLUMNS} from places where id = $1 and deleted_at is null and (owner_id = $2 or (visibility = 'public' and admin_hidden_at is null))"
    ))
    .bind(id)
    .bind(viewer)
    .fetch_optional(db)
    .await?
    .ok_or_else(AppError::not_found)
}

async fn audit_place(state: &AppState, meta: &RequestMeta, actor: Uuid, action: &str, id: Uuid) {
    audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("place"),
            target_id: Some(id.to_string()),
            meta: json!({}),
        },
    )
    .await;
}

pub async fn create(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<WriteInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let draft = Draft::from_input(input, None)?;
    let mut tx = state.db.begin().await?;
    // Serialises creates per owner so the count below can't be beaten by parallel requests.
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("places:{}", viewer.id))
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(
        "select count(*) from places where owner_id = $1 and deleted_at is null",
    )
    .bind(viewer.id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_PLACES_PER_OWNER {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "You've reached the limit of places for one account.",
        ));
    }
    let row: PlaceRow = sqlx::query_as(&format!(
        "insert into places (owner_id, name, description, lat, lng, address, category, visibility)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning {COLUMNS}"
    ))
    .bind(viewer.id)
    .bind(&draft.name)
    .bind(&draft.description)
    .bind(draft.lat)
    .bind(draft.lng)
    .bind(&draft.address)
    .bind(&draft.category)
    .bind(&draft.visibility)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    audit_place(&state, &meta, viewer.id, "place.create", row.id).await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": place_json(&row, Some(viewer.id))? })),
    ))
}

pub async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let viewer_id = viewer.as_ref().map(|viewer| viewer.id);
    let row = fetch_visible(&state.db, id, viewer_id).await?;
    Ok(Json(json!({ "data": place_json(&row, viewer_id)? })))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<WriteInput>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut tx = state.db.begin().await?;
    // Lock the row so moderation cannot race with a visibility change.
    let current: PlaceRow = sqlx::query_as(&format!(
        "select {COLUMNS} from places where id = $1 and owner_id = $2 and deleted_at is null for update"
    ))
    .bind(id)
    .bind(viewer.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    if current.admin_hidden_at.is_some() && input.visibility.as_deref() == Some("public") {
        return Err(invalid(
            json!([{ "path": "/visibility", "message": "A hidden place cannot be made public." }]),
        ));
    }
    let draft = Draft::from_input(input, Some(&current))?;
    let row: PlaceRow = sqlx::query_as(&format!(
        "update places set name = $2, description = $3, lat = $4, lng = $5, address = $6,
             category = $7, visibility = $8, updated_at = now()
         where id = $1 and owner_id = $9 and deleted_at is null
         returning {COLUMNS}"
    ))
    .bind(id)
    .bind(&draft.name)
    .bind(&draft.description)
    .bind(draft.lat)
    .bind(draft.lng)
    .bind(&draft.address)
    .bind(&draft.category)
    .bind(&draft.visibility)
    .bind(viewer.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    tx.commit().await?;
    audit_place(&state, &meta, viewer.id, "place.update", id).await;
    Ok(Json(json!({ "data": place_json(&row, Some(viewer.id))? })))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<StatusCode> {
    let id = parse_id(&id)?;
    let result = sqlx::query(
        "update places set deleted_at = now(), updated_at = now()
         where id = $1 and owner_id = $2 and deleted_at is null",
    )
    .bind(id)
    .bind(viewer.id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit_place(&state, &meta, viewer.id, "place.delete", id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Sets or clears the moderation flag. For the admin crate to call inside its own transaction, so the
/// flag change and its audit entry commit together. A hidden place disappears from every view except
/// its owner's. Re-hiding keeps the original timestamp. Missing or deleted places answer 404.
pub async fn set_admin_hidden(
    tx: &mut sqlx::PgConnection,
    place_id: Uuid,
    hidden: bool,
) -> AppResult<()> {
    let result = sqlx::query(
        "update places
         set admin_hidden_at = case when $2::bool then coalesce(admin_hidden_at, now()) else null end
         where id = $1 and deleted_at is null",
    )
    .bind(place_id)
    .bind(hidden)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    Ok(())
}

/// `GET /places?bbox=minLng,minLat,maxLng,maxLat&q&category&limit`: the viewer's own places plus
/// public ones inside the view. Anonymous viewers see only public places.
pub async fn list(
    State(state): State<AppState>,
    viewer: Option<Viewer>,
    RawQuery(raw): RawQuery,
) -> AppResult<Json<Value>> {
    let params = validate::query_params(raw.as_deref(), &["bbox", "q", "category", "limit"])?;
    let bbox = validate::bbox(params.get("bbox").ok_or_else(|| {
        invalid(json!([{ "path": "?bbox", "message": "Add the map view as bbox." }]))
    })?)?;
    let q = search_term(params.get("q"))?;
    let category = match params.get("category").map(String::as_str).map(str::trim) {
        Some(raw) if !raw.is_empty() => {
            let mut problems = Problems::default();
            let value = validate::category(&mut problems, raw);
            problems.finish()?;
            Some(value)
        }
        _ => None,
    };
    let limit = validate::limit(
        params.get("limit").map(String::as_str),
        DEFAULT_LIST_LIMIT,
        MAX_LIST_LIMIT,
    )?;
    let viewer_id = viewer.as_ref().map(|viewer| viewer.id);

    // One extra row tells us whether the view had more places than we return.
    let rows: Vec<PlaceRow> = sqlx::query_as(&format!(
        "select {COLUMNS} from places
         where deleted_at is null and (owner_id = $1::uuid or (visibility = 'public' and admin_hidden_at is null))
           and lat between $2 and $3
           and case when $4::bool then (lng >= $5 or lng <= $6) else lng between $5 and $6 end
           and ($7::text is null or category = $7)
           and ($8::text is null or strpos(lower(name), lower($8)) > 0
                or strpos(lower(description), lower($8)) > 0)
         order by created_at desc, id desc
         limit $9"
    ))
    .bind(viewer_id)
    .bind(bbox.min_lat)
    .bind(bbox.max_lat)
    .bind(bbox.lng.wrap)
    .bind(bbox.lng.from)
    .bind(bbox.lng.to)
    .bind(category)
    .bind(q)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;

    let truncated = rows.len() as i64 > limit;
    let data = rows
        .iter()
        .take(limit as usize)
        .map(|row| place_json(row, viewer_id))
        .collect::<AppResult<Vec<Value>>>()?;
    Ok(Json(
        json!({ "data": data, "meta": { "truncated": truncated, "limit": limit } }),
    ))
}

/// `GET /places/nearby?lat&lng&radiusKm&limit`: closest first, with the distance in metres.
pub async fn nearby(
    State(state): State<AppState>,
    viewer: Option<Viewer>,
    RawQuery(raw): RawQuery,
) -> AppResult<Json<Value>> {
    let params = validate::query_params(raw.as_deref(), &["lat", "lng", "radiusKm", "limit"])?;
    let lat = required_number(&params, "lat", -90.0, 90.0)?;
    let lng = required_number(&params, "lng", -180.0, 180.0)?;
    let radius_km = match params.get("radiusKm") {
        Some(raw) => validate::number_param("radiusKm", raw, MIN_RADIUS_KM, MAX_RADIUS_KM)?,
        None => DEFAULT_RADIUS_KM,
    };
    let limit = validate::limit(
        params.get("limit").map(String::as_str),
        DEFAULT_NEARBY_LIMIT,
        MAX_NEARBY_LIMIT,
    )?;
    let viewer_id = viewer.as_ref().map(|viewer| viewer.id);
    let (min_lat, max_lat, window) = validate::circle_window(lat, lng, radius_km);
    let rows = nearby_rows(
        &state.db,
        NearbyQuery {
            lat,
            lng,
            meters: radius_km * 1000.0,
            min_lat,
            max_lat,
            window,
            viewer: viewer_id,
            limit,
        },
    )
    .await?;
    let data = rows
        .iter()
        .map(|row| nearby_json(row, viewer_id))
        .collect::<AppResult<Vec<Value>>>()?;
    Ok(Json(json!({ "data": data })))
}

fn required_number(
    params: &std::collections::HashMap<String, String>,
    name: &str,
    min: f64,
    max: f64,
) -> AppResult<f64> {
    let raw = params.get(name).ok_or_else(|| {
        invalid(json!([{ "path": format!("?{name}"), "message": "This value is required." }]))
    })?;
    validate::number_param(name, raw, min, max)
}

/// Optional free-text search over name and description. Empty means no filter.
fn search_term(raw: Option<&String>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut problems = Problems::default();
    let value = validate::text(&mut problems, "?q", raw, 100, false);
    problems.finish()?;
    Ok((!value.is_empty()).then_some(value))
}

struct NearbyQuery {
    lat: f64,
    lng: f64,
    meters: f64,
    min_lat: f64,
    max_lat: f64,
    window: LngRange,
    viewer: Option<Uuid>,
    limit: i64,
}

/// Distances use the haversine formula. The bounding window in the WHERE clause is only a fast
/// pre-filter; the exact distance decides which rows are kept.
async fn nearby_rows(db: &PgPool, query: NearbyQuery) -> AppResult<Vec<NearbyRow>> {
    let rows = sqlx::query_as(&format!(
        "select * from (
             select {COLUMNS},
                 2 * 6371000.0 * asin(least(1.0, sqrt(
                     power(sin(radians(lat - $1::float8) / 2), 2)
                     + cos(radians($1::float8)) * cos(radians(lat)) * power(sin(radians(lng - $2::float8) / 2), 2)
                 ))) as meters
             from places
             where deleted_at is null and (owner_id = $3::uuid or (visibility = 'public' and admin_hidden_at is null))
               and lat between $4 and $5
               and case when $6::bool then (lng >= $7 or lng <= $8) else lng between $7 and $8 end
         ) as near
         where meters <= $9
         order by meters, id
         limit $10"
    ))
    .bind(query.lat)
    .bind(query.lng)
    .bind(query.viewer)
    .bind(query.min_lat)
    .bind(query.max_lat)
    .bind(query.window.wrap)
    .bind(query.window.from)
    .bind(query.window.to)
    .bind(query.meters)
    .bind(query.limit)
    .fetch_all(db)
    .await?;
    Ok(rows)
}
