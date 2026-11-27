//! Bookings: create (idempotent, capacity-checked under a lock), list for the booker or the
//! owner, and cancel.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono_tz::Tz;
use kernel::extract::{Json, Path, Query};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, request::RequestMeta, security::enforce_rate_limit,
    viewer::Viewer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    clock, cursor, emails, idempotency, resources,
    schedule::{self},
    store::{self, Resource},
    validate::{self, Problems},
};

const BOOKING_SELECT: &str = "select b.id, b.resource_id, r.name as resource_name,
        r.timezone as resource_timezone,
        b.booker_id, u.display_name as booker_name, u.email::text as booker_email,
        b.starts_at, b.ends_at, b.seats, b.status, b.note, b.created_at, b.cancelled_at
    from booking_bookings b
    join booking_resources r on r.id = b.resource_id
    join users u on u.id = b.booker_id";

#[derive(sqlx::FromRow)]
pub struct BookingRow {
    id: Uuid,
    resource_id: Uuid,
    resource_name: String,
    resource_timezone: String,
    booker_id: Uuid,
    booker_name: String,
    /// Only used to send emails. Never part of the JSON, so owners don't see booker addresses.
    booker_email: String,
    starts_at: OffsetDateTime,
    ends_at: OffsetDateTime,
    seats: i32,
    status: String,
    note: String,
    created_at: OffsetDateTime,
    cancelled_at: Option<OffsetDateTime>,
}

impl BookingRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "resourceId": self.resource_id,
            "resourceName": self.resource_name,
            "resourceTimezone": self.resource_timezone,
            "bookerName": self.booker_name,
            "startsAt": clock::rfc3339(self.starts_at),
            "endsAt": clock::rfc3339(self.ends_at),
            "seats": self.seats,
            "status": self.status,
            "note": self.note,
            "createdAt": clock::rfc3339(self.created_at),
            "cancelledAt": self.cancelled_at.map(clock::rfc3339),
        })
    }

    fn zone(&self) -> AppResult<Tz> {
        self.resource_timezone
            .parse::<Tz>()
            .map_err(|_| AppError::internal("stored time zone is invalid"))
    }
}

/// Loads one booking, if the viewer is its booker or the resource's owner. Anyone else gets `None`,
/// which the caller turns into 404. Pass `lock` inside a transaction that changes the row.
async fn find_booking(
    db: &mut PgConnection,
    id: Uuid,
    viewer: Uuid,
    lock: bool,
) -> AppResult<Option<BookingRow>> {
    let lock_clause = if lock { " for update of b" } else { "" };
    let sql = format!(
        "{BOOKING_SELECT} where b.id = $1 and (b.booker_id = $2 or r.owner_id = $2){lock_clause}"
    );
    Ok(sqlx::query_as(&sql)
        .bind(id)
        .bind(viewer)
        .fetch_optional(db)
        .await?)
}

/// A unique violation on the exclusion constraint means a rival booking won the slot.
fn map_insert_error(error: sqlx::Error) -> AppError {
    match &error {
        sqlx::Error::Database(database) if database.code().as_deref() == Some("23P01") => {
            AppError::new(ErrorCode::Conflict, "That time is already booked.")
        }
        _ => AppError::from(error),
    }
}

fn parse_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateInput {
    starts_at: String,
    seats: Option<i32>,
    note: Option<String>,
}

/// Books one slot. The start must be a real slot start for the resource's hours, in the future,
/// and have enough seats left. Parallel requests for one resource are serialised by a lock, and
/// the exclusion constraint on single-seat resources backs that up in the database.
pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let resource_id = parse_id(&id)?;
    let mut problems = Problems::default();
    let starts = validate::instant(&mut problems, "/startsAt", &input.starts_at);
    let seats = validate::seats(&mut problems, "/seats", input.seats.unwrap_or(1));
    let note = validate::note(&mut problems, "/note", input.note.as_deref().unwrap_or(""));
    problems.finish()?;
    let starts_utc = clock::to_chrono(starts)?;

    // Hashed on the normalised values, so the same booking sent with different JSON still matches.
    let key = idempotency::key(&headers)?;
    let hash = idempotency::hash(
        &format!("booking.create:{resource_id}"),
        &json!({ "startsAt": clock::rfc3339(starts), "seats": seats, "note": note }),
    )?;
    enforce_rate_limit(
        &state.db,
        &format!("booking:create:{}", viewer.id),
        store::CREATE_BOOKING_LIMIT,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    if let Some(key) = &key
        && let Some(stored) = idempotency::reserve(&mut tx, viewer.id, key, &hash).await?
    {
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(stored)));
    }

    store::lock_resource(&mut tx, resource_id).await?;
    let resource: Resource = store::find_resource(&mut tx, resource_id)
        .await?
        .filter(|resource| resource.readable_by(Some(&viewer)))
        .ok_or_else(AppError::not_found)?;
    let zone = resource.zone()?;
    let capacity = i64::from(resource.capacity);

    let mut problems = Problems::default();
    if i64::from(seats) > capacity {
        problems.add(
            "/seats",
            &format!(
                "This resource holds at most {} per booking.",
                resource.capacity
            ),
        );
    }
    if starts_utc <= clock::to_chrono(clock::now())? {
        problems.add("/startsAt", "That time has already passed.");
    }
    problems.finish()?;

    let day = schedule::local_date(zone, starts_utc);
    let first = day.pred_opt().unwrap_or(day);
    let last = day.succ_opt().unwrap_or(day);
    let hours = store::load_hours(&mut tx, &resource, first, last).await?;
    if !schedule::is_slot_start(&hours, starts_utc) {
        return Err(validate::invalid(
            "/startsAt",
            "Pick a start time from the slot list.",
        ));
    }
    let ends_utc = starts_utc + hours.slot;

    let upcoming: i64 = sqlx::query_scalar(
        "select count(*) from booking_bookings
         where resource_id = $1 and booker_id = $2 and status = 'confirmed' and starts_at > $3",
    )
    .bind(resource_id)
    .bind(viewer.id)
    .bind(clock::now())
    .fetch_one(&mut *tx)
    .await?;
    if upcoming >= store::MAX_UPCOMING_PER_USER {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            format!(
                "You already have {} upcoming bookings here.",
                store::MAX_UPCOMING_PER_USER
            ),
        ));
    }

    let booked = store::load_booked(&mut tx, resource_id, starts_utc, ends_utc).await?;
    let taken = schedule::seats_taken(&booked, starts_utc, ends_utc);
    if taken + i64::from(seats) > capacity {
        let message = if capacity == 1 {
            "That time is already booked."
        } else {
            "There aren't enough seats left at that time."
        };
        return Err(AppError::new(ErrorCode::Conflict, message));
    }

    let booking_id: Uuid = sqlx::query_scalar(
        "insert into booking_bookings (resource_id, booker_id, starts_at, ends_at, seats, exclusive, note)
         values ($1, $2, $3, $4, $5, $6, $7) returning id",
    )
    .bind(resource_id)
    .bind(viewer.id)
    .bind(starts)
    .bind(clock::from_chrono(ends_utc)?)
    .bind(seats)
    .bind(resource.capacity == 1)
    .bind(note.as_str())
    .fetch_one(&mut *tx)
    .await
    .map_err(map_insert_error)?;

    let booking = find_booking(&mut tx, booking_id, viewer.id, false)
        .await?
        .ok_or_else(|| AppError::internal("booking missing after insert"))?;
    let response = json!({ "data": booking.json() });
    if let Some(key) = &key {
        idempotency::store(&mut tx, viewer.id, key, &response).await?;
    }
    tx.commit().await?;

    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.create",
        booking_id,
        json!({ "resourceId": resource_id, "seats": seats }),
    )
    .await;
    emails::send(
        &state,
        emails::confirmed(&viewer.email, &resource.name, zone, starts_utc),
    );
    Ok((StatusCode::CREATED, Json(response)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookingsQuery {
    /// "upcoming" (the default) or "past".
    when: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Clone, Copy)]
enum Scope {
    Booker(Uuid),
    Resource(Uuid),
}

/// One page of bookings, newest first for past ones and soonest first for upcoming ones.
/// Cancelled bookings stay in the list, so history is complete.
async fn page(db: &PgPool, scope: Scope, query: BookingsQuery, list: &str) -> AppResult<Value> {
    let upcoming = match query.when.as_deref() {
        None | Some("upcoming") => true,
        Some("past") => false,
        Some(_) => return Err(validate::invalid("when", "Use upcoming or past.")),
    };
    let limit = cursor::page_limit(query.limit)?;
    let kind = format!("{list}:{}", if upcoming { "upcoming" } else { "past" });
    let after = query
        .cursor
        .as_deref()
        .map(|raw| cursor::decode(raw, &kind))
        .transpose()?;
    let (after_at, after_id) = after.unzip();
    let (column, scope_id) = match scope {
        Scope::Booker(id) => ("b.booker_id", id),
        Scope::Resource(id) => ("b.resource_id", id),
    };
    // Only fixed fragments are interpolated; every value is bound.
    let (now_op, key_op, order) = if upcoming {
        (">", ">", "asc")
    } else {
        ("<=", "<", "desc")
    };
    let sql = format!(
        "{BOOKING_SELECT}
         where {column} = $1 and b.starts_at {now_op} $2
           and ($3::timestamptz is null or (b.starts_at, b.id) {key_op} ($3, $4))
         order by b.starts_at {order}, b.id {order} limit $5"
    );
    let mut rows: Vec<BookingRow> = sqlx::query_as(&sql)
        .bind(scope_id)
        .bind(clock::now())
        .bind(after_at)
        .bind(after_id)
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
    let next = cursor::trim_page(&mut rows, limit, |row| {
        cursor::encode(&kind, row.starts_at, row.id)
    })?;
    Ok(json!({
        "data": rows.iter().map(BookingRow::json).collect::<Vec<_>>(),
        "meta": { "nextCursor": next },
    }))
}

/// The viewer's own bookings.
pub async fn mine(
    State(state): State<AppState>,
    viewer: Viewer,
    Query(query): Query<BookingsQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        page(&state.db, Scope::Booker(viewer.id), query, "mine").await?,
    ))
}

/// Every booking on one resource, for its owner.
pub async fn for_resource(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    Query(query): Query<BookingsQuery>,
) -> AppResult<Json<Value>> {
    let resource_id = parse_id(&id)?;
    let mut conn = state.db.acquire().await?;
    resources::owned(&mut conn, resource_id, &viewer).await?;
    drop(conn);
    Ok(Json(
        page(
            &state.db,
            Scope::Resource(resource_id),
            query,
            &format!("resource:{resource_id}"),
        )
        .await?,
    ))
}

/// Cancels a booking. The booker can cancel their own; the owner can cancel any on their
/// resource. Cancelling again is a no-op. Nothing can be cancelled once it has started.
pub async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<Json<Value>> {
    let booking_id = parse_id(&id)?;
    let now = clock::now();
    let mut tx = state.db.begin().await?;
    let mut booking = find_booking(&mut tx, booking_id, viewer.id, true)
        .await?
        .ok_or_else(AppError::not_found)?;

    if booking.status == "cancelled" {
        tx.commit().await?;
        return Ok(Json(json!({ "data": booking.json() })));
    }
    if booking.starts_at <= now {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "This booking has already started, so it can't be cancelled.",
        ));
    }
    sqlx::query(
        "update booking_bookings set status = 'cancelled', cancelled_at = $2
         where id = $1 and status = 'confirmed'",
    )
    .bind(booking_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let by_booker = viewer.id == booking.booker_id;
    booking.status = "cancelled".to_owned();
    booking.cancelled_at = Some(now);
    store::log(
        &state,
        &meta,
        viewer.id,
        "booking.cancel",
        booking_id,
        json!({ "by": if by_booker { "booker" } else { "owner" } }),
    )
    .await;
    if !by_booker {
        let email = emails::cancelled(
            &booking.booker_email,
            &booking.resource_name,
            booking.zone()?,
            clock::to_chrono(booking.starts_at)?,
        );
        emails::send(&state, email);
    }
    Ok(Json(json!({ "data": booking.json() })))
}
