//! Shared database reads and locks for resources, hours, exceptions and bookings.
//!
//! Every booking change for a resource runs under `lock_resource`, so the capacity check and the
//! insert can't interleave with another request for the same resource.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use chrono_tz::Tz;
use kernel::{
    AppError, AppResult, AppState,
    request::RequestMeta,
    security::{AuditEntry, Limit, audit},
    viewer::Viewer,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    clock,
    schedule::{self, Booked, Hours, Window},
};

/// Most resources one owner may keep (deleted ones don't count).
pub const MAX_RESOURCES_PER_OWNER: i64 = 50;
/// Most upcoming confirmed bookings one person may hold on one resource.
pub const MAX_UPCOMING_PER_USER: i64 = 10;
/// Booking creation attempts per person per hour, counted before the request is checked.
pub const CREATE_BOOKING_LIMIT: Limit = Limit {
    limit: 60,
    window: std::time::Duration::from_secs(60 * 60),
};
/// Exceptions can be set this many months ahead.
pub const EXCEPTION_HORIZON_MONTHS: u32 = 36;

pub const RESOURCE_COLUMNS: &str = "id, owner_id, name, description, timezone, slot_minutes, capacity, visibility, created_at, updated_at";

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Resource {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: String,
    pub timezone: String,
    pub slot_minutes: i32,
    pub capacity: i32,
    pub visibility: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl Resource {
    pub fn is_owner(&self, viewer: &Viewer) -> bool {
        self.owner_id == viewer.id
    }

    /// Public resources are visible to everyone; private ones only to their owner.
    pub fn readable_by(&self, viewer: Option<&Viewer>) -> bool {
        self.visibility == "public" || viewer.is_some_and(|viewer| self.is_owner(viewer))
    }

    pub fn zone(&self) -> AppResult<Tz> {
        self.timezone
            .parse::<Tz>()
            .map_err(|_| AppError::internal("stored time zone is invalid"))
    }

    pub fn slot(&self) -> TimeDelta {
        TimeDelta::minutes(i64::from(self.slot_minutes))
    }

    pub fn json(&self, viewer: Option<&Viewer>) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "timezone": self.timezone,
            "slotMinutes": self.slot_minutes,
            "capacity": self.capacity,
            "visibility": self.visibility,
            "isOwner": viewer.is_some_and(|viewer| self.is_owner(viewer)),
            "createdAt": clock::rfc3339(self.created_at),
            "updatedAt": clock::rfc3339(self.updated_at),
        })
    }
}

/// A live (not deleted) resource.
pub async fn find_resource(db: &mut PgConnection, id: Uuid) -> AppResult<Option<Resource>> {
    let sql = format!(
        "select {RESOURCE_COLUMNS} from booking_resources where id = $1 and deleted_at is null"
    );
    Ok(sqlx::query_as(&sql).bind(id).fetch_optional(db).await?)
}

/// Serialises booking changes for one resource until the transaction ends.
pub async fn lock_resource(db: &mut PgConnection, id: Uuid) -> AppResult<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("booking:resource:{id}"))
        .execute(db)
        .await?;
    Ok(())
}

/// Serialises resource creation for one owner, so the per-owner cap can't be raced past.
pub async fn lock_owner(db: &mut PgConnection, owner: Uuid) -> AppResult<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("booking:owner:{owner}"))
        .execute(db)
        .await?;
    Ok(())
}

fn window_of(start: i32, end: i32) -> AppResult<Window> {
    Ok(Window {
        start: u16::try_from(start).map_err(AppError::internal)?,
        end: u16::try_from(end).map_err(AppError::internal)?,
    })
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    weekday: i32,
    start_minute: i32,
    end_minute: i32,
}

/// Weekly windows as (weekday, window), in order.
pub async fn load_rules(db: &mut PgConnection, resource: Uuid) -> AppResult<Vec<(u32, Window)>> {
    let rows: Vec<RuleRow> = sqlx::query_as(
        "select weekday::integer as weekday, start_minute, end_minute
         from booking_rules where resource_id = $1 order by weekday, start_minute",
    )
    .bind(resource)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                u32::try_from(row.weekday).map_err(AppError::internal)?,
                window_of(row.start_minute, row.end_minute)?,
            ))
        })
        .collect()
}

#[derive(sqlx::FromRow)]
pub struct ExceptionRow {
    pub local_date: String,
    pub closed: bool,
    pub start_minute: Option<i32>,
    pub end_minute: Option<i32>,
}

impl ExceptionRow {
    /// `None` when the day is closed.
    pub fn window(&self) -> AppResult<Option<Window>> {
        if self.closed {
            return Ok(None);
        }
        match (self.start_minute, self.end_minute) {
            (Some(start), Some(end)) => Ok(Some(window_of(start, end)?)),
            _ => Err(AppError::internal("open exception without hours")),
        }
    }
}

const EXCEPTION_COLUMNS: &str =
    "to_char(local_date, 'YYYY-MM-DD') as local_date, closed, start_minute, end_minute";

/// Exceptions whose date falls between `first` and `last`, keyed by date.
pub async fn load_exceptions(
    db: &mut PgConnection,
    resource: Uuid,
    first: NaiveDate,
    last: NaiveDate,
) -> AppResult<BTreeMap<NaiveDate, Option<Window>>> {
    let rows: Vec<ExceptionRow> = sqlx::query_as(&format!(
        "select {EXCEPTION_COLUMNS} from booking_exceptions
         where resource_id = $1 and local_date between $2::date and $3::date"
    ))
    .bind(resource)
    .bind(first.to_string())
    .bind(last.to_string())
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let day = NaiveDate::parse_from_str(&row.local_date, "%Y-%m-%d")
                .map_err(AppError::internal)?;
            Ok((day, row.window()?))
        })
        .collect()
}

/// Exceptions on or after `from`, in date order, for the owner's settings page.
pub async fn exceptions_from(
    db: &mut PgConnection,
    resource: Uuid,
    from: NaiveDate,
) -> AppResult<Vec<ExceptionRow>> {
    Ok(sqlx::query_as(&format!(
        "select {EXCEPTION_COLUMNS} from booking_exceptions
         where resource_id = $1 and local_date >= $2::date order by local_date limit 1000"
    ))
    .bind(resource)
    .bind(from.to_string())
    .fetch_all(db)
    .await?)
}

/// Everything the slot maths needs for a resource, covering local dates `first` to `last`.
pub async fn load_hours(
    db: &mut PgConnection,
    resource: &Resource,
    first: NaiveDate,
    last: NaiveDate,
) -> AppResult<Hours> {
    Ok(Hours {
        tz: resource.zone()?,
        slot: resource.slot(),
        weekly: load_rules(db, resource.id).await?,
        exceptions: load_exceptions(db, resource.id, first, last).await?,
    })
}

#[derive(sqlx::FromRow)]
struct BookedRow {
    starts_at: OffsetDateTime,
    ends_at: OffsetDateTime,
    seats: i32,
}

/// Confirmed bookings that overlap `[from, to)`.
pub async fn load_booked(
    db: &mut PgConnection,
    resource: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> AppResult<Vec<Booked>> {
    let rows: Vec<BookedRow> = sqlx::query_as(
        "select starts_at, ends_at, seats from booking_bookings
         where resource_id = $1 and status = 'confirmed' and starts_at < $3 and ends_at > $2",
    )
    .bind(resource)
    .bind(clock::from_chrono(from)?)
    .bind(clock::from_chrono(to)?)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Booked {
                starts: clock::to_chrono(row.starts_at)?,
                ends: clock::to_chrono(row.ends_at)?,
                seats: i64::from(row.seats),
            })
        })
        .collect()
}

/// The UTC span that covers every slot of local dates `first` to `last`.
pub fn day_span(
    zone: Tz,
    first: NaiveDate,
    last: NaiveDate,
) -> AppResult<(DateTime<Utc>, DateTime<Utc>)> {
    let from = schedule::local_to_utc(zone, first, 0)
        .ok_or_else(|| AppError::internal("no start of day"))?;
    let to = schedule::local_to_utc(zone, last, schedule::END_OF_DAY)
        .ok_or_else(|| AppError::internal("no end of day"))?;
    Ok((from, to))
}

/// Records a booking-side security or ownership event. Never fails the request.
pub async fn log(
    state: &AppState,
    meta: &RequestMeta,
    actor: Uuid,
    action: &str,
    target: Uuid,
    details: Value,
) {
    audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("booking"),
            target_id: Some(target.to_string()),
            meta: details,
        },
    )
    .await;
}
