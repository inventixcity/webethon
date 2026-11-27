-- Places: named points on a map, owned by one user. Public places are visible to everyone; private
-- ones only to their owner. Deleted rows stay for a while (soft delete) and are never returned.
create table places (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  address text not null default '' check (char_length(address) <= 300),
  category text not null default '' check (char_length(category) <= 40),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Bounding-box and radius searches filter on lat first (a range scan), then lng.
create index places_geo_idx on places (lat, lng) where deleted_at is null;
create index places_owner_idx on places (owner_id, created_at desc) where deleted_at is null;

-- Onboarding answers: one row per user. The keys are checked against an allow-list in the API.
create table onboarding_answers (
  user_id uuid primary key references users (id) on delete cascade,
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 16384),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Address search results, kept for 24 hours so repeated searches don't reach the geocoder again.
-- The key is a hash of the normalised query, so the table holds no readable search history.
create table geocode_cache (
  query_hash bytea primary key check (octet_length(query_hash) = 32),
  results jsonb not null check (jsonb_typeof(results) = 'array' and octet_length(results::text) <= 65536),
  fetched_at timestamptz not null default now()
);
create index geocode_cache_fetched_idx on geocode_cache (fetched_at);
