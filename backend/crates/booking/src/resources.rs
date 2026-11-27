//! Resources: create, read, edit, delete, weekly hours, date exceptions and the slot list.

use axum::{extract::State, http::StatusCode};
use chrono::{Months, NaiveDate};
use chrono_tz::Tz;
use kernel::extract::{Json, Path, Query};
use kernel::{AppError, AppResult, AppState, ErrorCode, request::RequestMeta, viewer::Viewer};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    clock, cursor, emails,
    schedule::{self, MAX_RANGE_DAYS, MAX_SLOTS, Slot, Window},
    store::{self, ExceptionRow, RESOURCE_COLUMNS, Resource},
    validate::{self, Problems},
};

fn parse_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found())
}

/// Loads a live resource the viewer may change. Non-owners get 404 for private resources, and 403
/// for public ones, because they can already see that those exist.
async fn writable(db: &mut PgConnection, id: Uuid, viewer: &Viewer) -> AppResult<Resource> {
    let resource = store::find_resource(db, id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if resource.is_owner(viewer) {
        return Ok(resource);
    }
    Err(if resource.visibility == "public" {
        AppError::forbidden()
    } else {
        AppError::not_found()
    })
}

/// Loads a live resource for owner-only data. Anyone else gets 404, even for public resources.
pub(crate) async fn owned(db: &mut PgConnection, id: Uuid, viewer: &Viewer) -> AppResult<Resource> {
    store::find_resource(db, id)
        .await?
        .filter(|resource| resource.is_owner(viewer))
        .ok_or_else(AppError::not_found)
}

/// Today's local date in a resource's time zone, which decides what counts as "past".
fn today_in(zone: Tz) -> AppResult<NaiveDate> {
    Ok(schedule::local_date(zone, clock::to_chrono(clock::now())?))
}

fn rules_json(rules: &[(u32, Window)]) -> Vec<Value> {
    rules
        .iter()
        .map(|(weekday, window)| {
            json!({
                "weekday": weekday,
                "startTime": schedule::label(window.start),
                "endTime": schedule::label(window.end),
            })
        })
        .collect()
}

fn exception_json(date: &str, window: Option<Window>) -> Value {
    json!({
        "date": date,
        "closed": window.is_none(),
        "startTime": window.map(|window| schedule::label(window.start)),
        "endTime": window.map(|window| schedule::label(window.end)),
    })
}

fn exceptions_json(rows: &[ExceptionRow]) -> AppResult<Vec<Value>> {
    rows.iter()
        .map(|row| Ok(exception_json(&row.local_date, row.window()?)))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResourceInput {
    name: Option<String>,
    description: Option<String>,
    timezone: Option<String>,
    slot_minutes: Option<i32>,
    capacity: Option<i32>,
    visibility: Option<String>,
}

/// Every setting of a resource after a create or patch has been merged and checked.
struct Settings {
    name: String,
    description: String,
    timezone: String,
    slot_minutes: i32,
    capacity: i32,
    visibility: String,
}

/// Merges the input onto the current values (for a patch) or requires every field (for a create).
fn settings(input: &ResourceInput, current: Option<&Resource>, p: &mut Problems) -> Settings {
    let name = match (&input.name, current) {
        (Some(raw), _) => validate::name(p, "/name", raw),
        (None, Some(current)) => current.name.clone(),
        (None, None) => {
            p.add("/name", "Please give it a name.");
            String::new()
        }
    };
    let description = match (&input.description, current) {
        (Some(raw), _) => validate::description(p, "/description", raw),
        (None, Some(current)) => current.description.clone(),
        (None, None) => String::new(),
    };
    let timezone = match (&input.timezone, current) {
        (Some(raw), _) => validate::timezone(p, "/timezone", raw),
        (None, Some(current)) => current.timezone.clone(),
        (None, None) => {
            p.add("/timezone", "Pick a time zone such as Europe/London.");
            "UTC".to_owned()
        }
    };
    let slot_minutes = match (input.slot_minutes, current) {
        (Some(value), _) => validate::slot_minutes(p, "/slotMinutes", value),
        (None, Some(current)) => current.slot_minutes,
        (None, None) => {
            p.add("/slotMinutes", "Required.");
            0
        }
    };
    let capacity = match (input.capacity, current) {
        (Some(value), _) => validate::capacity(p, "/capacity", value),
        (None, Some(current)) => current.capacity,
        (None, None) => {
            p.add("/capacity", "Required.");
            0
        }
    };
    let visibility = match (&input.visibility, current) {
        (Some(raw), _) => validate::visibility(p, "/visibility", raw),
        (None, Some(current)) => current.visibility.clone(),
        (None, None) => "private".to_owned(),
    };
    Settings {
        name,
        description,
        timezone,
        slot_minutes,
        capacity,
        visibility,
    }
}

pub async fn create(
    State(state): State<AppState>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<ResourceInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut problems = Problems::default();
    let values = settings(&input, None, &mut problems);
    problems.finish()?;

    let mut tx = state.db.begin().await?;
    // Serialised per owner so two parallel requests can't both pass the cap.
    store::lock_owner(&mut tx, viewer.id).await?;
    let owned: i64 = sqlx::query_scalar(
        "select count(*) from booking_resources where owner_id = $1 and deleted_at is null",
    )
    .bind(viewer.id)
    .fetch_one(&mut *tx)
    .await?;
    if owned >= store::MAX_RESOURCES_PER_OWNER {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            format!(
                "You've reached the limit of {} resources.",
                store::MAX_RESOURCES_PER_OWNER
            ),
        ));
    }
    let resource: Resource = sqlx::query_as(&format!(
        "insert into booking_resources (owner_id, name, description, timezone, slot_minutes, capacity, visibility)
         values ($1, $2, $3, $4, $5, $6, $7) returning {RESOURCE_COLUMNS}"
    ))
    .bind(viewer.id)
    .bind(values.name.as_str())
    .bind(values.description.as_str())
    .bind(values.timezone.as_str())
    .bind(values.slot_minutes)
    .bind(values.capacity)
    .bind(values.visibility.as_str())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.resource.create",
        resource.id,
        json!({}),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": resource.json(Some(&viewer)) })),
    ))
}

pub async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut conn = state.db.acquire().await?;
    let resource = store::find_resource(&mut conn, id)
        .await?
        .filter(|resource| resource.readable_by(viewer.as_ref()))
        .ok_or_else(AppError::not_found)?;
    Ok(Json(json!({ "data": resource.json(viewer.as_ref()) })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

/// Resources the viewer owns, plus public ones. Anonymous callers see only public ones.
pub async fn list(
    State(state): State<AppState>,
    viewer: Option<Viewer>,
    Query(query): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let limit = cursor::page_limit(query.limit)?;
    let after = query
        .cursor
        .as_deref()
        .map(|raw| cursor::decode(raw, "resources"))
        .transpose()?;
    let (after_at, after_id) = after.unzip();
    let mut rows: Vec<Resource> = sqlx::query_as(&format!(
        "select {RESOURCE_COLUMNS} from booking_resources
         where deleted_at is null and (owner_id = $1 or visibility = 'public')
           and ($2::timestamptz is null or (created_at, id) < ($2, $3))
         order by created_at desc, id desc limit $4"
    ))
    .bind(viewer.as_ref().map(|viewer| viewer.id))
    .bind(after_at)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let next = cursor::trim_page(&mut rows, limit, |row| {
        cursor::encode("resources", row.created_at, row.id)
    })?;
    Ok(Json(json!({
        "data": rows.iter().map(|row| row.json(viewer.as_ref())).collect::<Vec<_>>(),
        "meta": { "nextCursor": next },
    })))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<ResourceInput>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut tx = state.db.begin().await?;
    let current = writable(&mut tx, id, &viewer).await?;
    let mut problems = Problems::default();
    let values = settings(&input, Some(&current), &mut problems);
    problems.finish()?;

    let resource: Resource = sqlx::query_as(&format!(
        "update booking_resources
         set name = $2, description = $3, timezone = $4, slot_minutes = $5, capacity = $6, visibility = $7
         where id = $1 and deleted_at is null returning {RESOURCE_COLUMNS}"
    ))
    .bind(id)
    .bind(values.name.as_str())
    .bind(values.description.as_str())
    .bind(values.timezone.as_str())
    .bind(values.slot_minutes)
    .bind(values.capacity)
    .bind(values.visibility.as_str())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(AppError::not_found)?;
    tx.commit().await?;

    // Only the names of the changed fields are logged, never their values.
    let fields: Vec<&str> = [
        ("name", input.name.is_some()),
        ("description", input.description.is_some()),
        ("timezone", input.timezone.is_some()),
        ("slotMinutes", input.slot_minutes.is_some()),
        ("capacity", input.capacity.is_some()),
        ("visibility", input.visibility.is_some()),
    ]
    .into_iter()
    .filter(|(_, given)| *given)
    .map(|(name, _)| name)
    .collect();
    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.resource.update",
        id,
        json!({ "fields": fields }),
    )
    .await;
    Ok(Json(json!({ "data": resource.json(Some(&viewer)) })))
}

/// Soft-deletes a resource and cancels its future bookings, emailing each booker.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<StatusCode> {
    let id = parse_id(&id)?;
    let mut tx = state.db.begin().await?;
    let resource = writable(&mut tx, id, &viewer).await?;
    store::lock_resource(&mut tx, id).await?;
    let now = clock::now();
    sqlx::query(
        "update booking_resources set deleted_at = $2 where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let cancelled: Vec<(String, time::OffsetDateTime)> = sqlx::query_as(
        "with cancelled as (
           update booking_bookings set status = 'cancelled', cancelled_at = $2
           where resource_id = $1 and status = 'confirmed' and starts_at > $2
           returning booker_id, starts_at
         )
         select u.email::text, c.starts_at from cancelled c join users u on u.id = c.booker_id",
    )
    .bind(id)
    .bind(now)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.resource.delete",
        id,
        json!({ "cancelledBookings": cancelled.len() }),
    )
    .await;
    let zone = resource.zone()?;
    for (email, starts) in cancelled {
        let email = emails::cancelled(&email, &resource.name, zone, clock::to_chrono(starts)?);
        emails::send(&state, email);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The owner's weekly hours and upcoming date exceptions.
pub async fn availability(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut conn = state.db.acquire().await?;
    let resource = owned(&mut conn, id, &viewer).await?;
    let today = today_in(resource.zone()?)?;
    let rules = store::load_rules(&mut conn, id).await?;
    let exceptions = store::exceptions_from(&mut conn, id, today).await?;
    Ok(Json(json!({
        "data": {
            "timezone": resource.timezone,
            "rules": rules_json(&rules),
            "exceptions": exceptions_json(&exceptions)?,
        }
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RulesInput {
    rules: Vec<RuleInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuleInput {
    weekday: i32,
    start_time: String,
    end_time: String,
}

/// Replaces the whole weekly schedule in one transaction.
pub async fn set_rules(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<RulesInput>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut tx = state.db.begin().await?;
    let resource = writable(&mut tx, id, &viewer).await?;

    let mut problems = Problems::default();
    if input.rules.len() > schedule::MAX_WEEKLY_WINDOWS {
        problems.add(
            "/rules",
            &format!(
                "Use at most {} windows a week.",
                schedule::MAX_WEEKLY_WINDOWS
            ),
        );
    }
    let mut windows: Vec<(u32, Window)> = Vec::with_capacity(input.rules.len());
    for (index, rule) in input.rules.iter().enumerate() {
        let weekday = validate::weekday(
            &mut problems,
            &format!("/rules/{index}/weekday"),
            rule.weekday,
        );
        let start = validate::clock_time(
            &mut problems,
            &format!("/rules/{index}/startTime"),
            &rule.start_time,
            false,
        );
        let end = validate::clock_time(
            &mut problems,
            &format!("/rules/{index}/endTime"),
            &rule.end_time,
            true,
        );
        if start >= end {
            problems.add(
                &format!("/rules/{index}/endTime"),
                "End must be after the start.",
            );
        }
        windows.push((weekday, Window { start, end }));
    }
    validate::no_overlaps(&mut problems, "/rules", &mut windows);
    problems.finish()?;

    store::lock_resource(&mut tx, id).await?;
    sqlx::query("delete from booking_rules where resource_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (weekday, window) in &windows {
        sqlx::query(
            "insert into booking_rules (resource_id, weekday, start_minute, end_minute)
             values ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(*weekday as i32)
        .bind(i32::from(window.start))
        .bind(i32::from(window.end))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.rules.update",
        id,
        json!({ "windows": windows.len() }),
    )
    .await;
    Ok(Json(json!({
        "data": { "timezone": resource.timezone, "rules": rules_json(&windows) }
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExceptionInput {
    closed: bool,
    start_time: Option<String>,
    end_time: Option<String>,
}

/// Sets one date: closed, or open for a custom window that replaces the weekly hours.
pub async fn set_exception(
    State(state): State<AppState>,
    Path((id, date)): Path<(String, String)>,
    viewer: Viewer,
    meta: RequestMeta,
    Json(input): Json<ExceptionInput>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut tx = state.db.begin().await?;
    let resource = writable(&mut tx, id, &viewer).await?;
    let today = today_in(resource.zone()?)?;

    let mut problems = Problems::default();
    let parsed = validate::date(&date);
    if parsed.is_none() {
        problems.add("/date", "Use a date like 2030-12-25.");
    }
    let day = parsed.unwrap_or(today);
    if day < today {
        problems.add("/date", "Exceptions can't be set for past dates.");
    }
    if today
        .checked_add_months(Months::new(store::EXCEPTION_HORIZON_MONTHS))
        .is_some_and(|horizon| day > horizon)
    {
        problems.add("/date", "Exceptions can be set up to three years ahead.");
    }
    let window = if input.closed {
        if input.start_time.is_some() || input.end_time.is_some() {
            problems.add("/startTime", "Closed days don't have hours.");
        }
        None
    } else {
        match (input.start_time.as_deref(), input.end_time.as_deref()) {
            (Some(start), Some(end)) => {
                let start = validate::clock_time(&mut problems, "/startTime", start, false);
                let end = validate::clock_time(&mut problems, "/endTime", end, true);
                if start >= end {
                    problems.add("/endTime", "End must be after the start.");
                }
                Some(Window { start, end })
            }
            _ => {
                problems.add(
                    "/startTime",
                    "Add a start and end time, or mark the day closed.",
                );
                None
            }
        }
    };
    problems.finish()?;

    store::lock_resource(&mut tx, id).await?;
    sqlx::query(
        "insert into booking_exceptions (resource_id, local_date, closed, start_minute, end_minute)
         values ($1, $2::date, $3, $4, $5)
         on conflict (resource_id, local_date) do update
           set closed = excluded.closed, start_minute = excluded.start_minute, end_minute = excluded.end_minute",
    )
    .bind(id)
    .bind(day.to_string())
    .bind(input.closed)
    .bind(window.map(|window| i32::from(window.start)))
    .bind(window.map(|window| i32::from(window.end)))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.exception.update",
        id,
        json!({ "date": day.to_string(), "closed": input.closed }),
    )
    .await;
    Ok(Json(
        json!({ "data": exception_json(&day.to_string(), window) }),
    ))
}

pub async fn delete_exception(
    State(state): State<AppState>,
    Path((id, date)): Path<(String, String)>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<StatusCode> {
    let id = parse_id(&id)?;
    let Some(day) = validate::date(&date) else {
        return Err(AppError::not_found());
    };
    let mut tx = state.db.begin().await?;
    writable(&mut tx, id, &viewer).await?;
    store::lock_resource(&mut tx, id).await?;
    let removed = sqlx::query(
        "delete from booking_exceptions where resource_id = $1 and local_date = $2::date",
    )
    .bind(id)
    .bind(day.to_string())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if removed == 0 {
        return Err(AppError::not_found());
    }
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.exception.delete",
        id,
        json!({ "date": day.to_string() }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotsQuery {
    from: Option<String>,
    to: Option<String>,
}

/// Free and taken slots between `from` and `to` (inclusive, local dates in the resource's zone).
/// Public resources can be read without signing in.
pub async fn slots(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Option<Viewer>,
    Query(query): Query<SlotsQuery>,
) -> AppResult<Json<Value>> {
    let id = parse_id(&id)?;
    let mut conn = state.db.acquire().await?;
    let resource = store::find_resource(&mut conn, id)
        .await?
        .filter(|resource| resource.readable_by(viewer.as_ref()))
        .ok_or_else(AppError::not_found)?;

    let fallback = today_in(Tz::UTC)?;
    let mut problems = Problems::default();
    let from = date_param(&mut problems, "/from", query.from.as_deref(), fallback);
    let to = date_param(&mut problems, "/to", query.to.as_deref(), fallback);
    if to < from {
        problems.add("/to", "The end date must be on or after the start date.");
    } else if (to - from).num_days() + 1 > MAX_RANGE_DAYS {
        problems.add("/to", "Choose at most 62 days at a time.");
    }
    problems.finish()?;

    let zone = resource.zone()?;
    // One extra day either side, so slots near local midnight or a clock change aren't cut off.
    let first = from.pred_opt().unwrap_or(from);
    let last = to.succ_opt().unwrap_or(to);
    let hours = store::load_hours(&mut conn, &resource, first, last).await?;
    let generated = schedule::generate(&hours, first, last);
    let (span_from, span_to) = store::day_span(zone, first, last)?;
    let booked = store::load_booked(&mut conn, id, span_from, span_to).await?;

    let now = clock::to_chrono(clock::now())?;
    let visible: Vec<&Slot> = generated
        .iter()
        .filter(|slot| slot.local_date >= from && slot.local_date <= to && slot.starts > now)
        .collect();
    if visible.len() > MAX_SLOTS {
        let mut too_many = Problems::default();
        too_many.add(
            "/to",
            "That's too many slots. Choose fewer days or longer slots.",
        );
        too_many.finish()?;
    }

    let capacity = i64::from(resource.capacity);
    let slots: Vec<Value> = visible
        .iter()
        .map(|slot| {
            let taken = schedule::seats_taken(&booked, slot.starts, slot.ends);
            json!({
                "startsAt": clock::utc_string(slot.starts),
                "endsAt": clock::utc_string(slot.ends),
                "localDate": slot.local_date.to_string(),
                "localStart": slot.local_start.format("%H:%M").to_string(),
                "localEnd": slot.local_end.format("%H:%M").to_string(),
                "seatsLeft": (capacity - taken).max(0),
            })
        })
        .collect();
    Ok(Json(json!({
        "data": {
            "timezone": resource.timezone,
            "slotMinutes": resource.slot_minutes,
            "capacity": resource.capacity,
            "from": from.to_string(),
            "to": to.to_string(),
            "slots": slots,
        }
    })))
}

/// Parses a required YYYY-MM-DD query value. On failure it records a problem and returns `fallback`,
/// which is never used because the caller returns the problem first.
fn date_param(
    problems: &mut Problems,
    path: &str,
    raw: Option<&str>,
    fallback: NaiveDate,
) -> NaiveDate {
    match raw.and_then(validate::date) {
        Some(day) => day,
        None => {
            problems.add(path, "Use a date like 2030-03-31.");
            fallback
        }
    }
}
