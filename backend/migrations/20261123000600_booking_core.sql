-- Booking and calendar kit: bookable resources (rooms, tutors, tables, events), weekly hours,
-- date exceptions and bookings.
--
-- Bookings are stored as UTC instants. Wall-clock hours are interpreted by the app in each
-- resource's own IANA time zone, so DST is handled there, not here.
-- Hours are minutes after local midnight (0..1440), so "24:00" needs no special casing.

create extension if not exists btree_gist;

-- ------------------------------------------------------------------ resources
create table booking_resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  -- Validated against the IANA database by the app (chrono-tz) before it gets here.
  timezone text not null check (char_length(timezone) between 1 and 64),
  -- Length of one bookable slot, which is also the length of every booking.
  slot_minutes integer not null check (slot_minutes between 5 and 480),
  -- Seats per slot. 1 means exclusive.
  capacity integer not null check (capacity between 1 and 1000),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index booking_resources_owner_idx on booking_resources (owner_id, created_at desc, id desc)
  where deleted_at is null;
create index booking_resources_public_idx on booking_resources (created_at desc, id desc)
  where deleted_at is null and visibility = 'public';

-- ------------------------------------------------------------------ weekly hours
-- weekday: 0 = Sunday ... 6 = Saturday (the same convention as JavaScript's getDay()).
-- Windows of one weekday must not overlap; the app checks that before replacing the set.
create table booking_rules (
  resource_id uuid not null references booking_resources (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  check (end_minute > start_minute),
  primary key (resource_id, weekday, start_minute)
);

-- ------------------------------------------------------------------ date exceptions
-- One row per local date. closed = true means no slots that day; otherwise the custom window
-- replaces the weekly hours for that date.
create table booking_exceptions (
  resource_id uuid not null references booking_resources (id) on delete cascade,
  local_date date not null,
  closed boolean not null,
  start_minute integer,
  end_minute integer,
  check (
    (closed and start_minute is null and end_minute is null)
    or (
      not closed
      and start_minute between 0 and 1439
      and end_minute between 1 and 1440
      and end_minute > start_minute
    )
  ),
  primary key (resource_id, local_date)
);

-- ------------------------------------------------------------------ bookings
create table booking_bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references booking_resources (id) on delete cascade,
  booker_id uuid not null references users (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  seats integer not null check (seats between 1 and 1000),
  -- Copied from the resource when the booking is made (capacity = 1). Only exclusive bookings
  -- get the overlap constraint below; multi-seat resources are counted under an advisory lock.
  exclusive boolean not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (ends_at > starts_at),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  -- The database itself refuses two confirmed exclusive bookings that overlap in time.
  exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed' and exclusive)
);
create index booking_bookings_resource_idx on booking_bookings (resource_id, starts_at, id);
create index booking_bookings_booker_idx on booking_bookings (booker_id, starts_at, id);

create trigger booking_resources_touch before update on booking_resources
  for each row execute function touch_updated_at();
