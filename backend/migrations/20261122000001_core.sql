-- Core schema for the generic backend. Plain Postgres 15+ (works on Supabase, Neon or a container).
--
-- Rules every table follows:
--   * Secrets are never stored: session tokens, email codes and reset tokens are kept only as hashes.
--   * Emails are unique case-insensitively (citext).
--   * Every write path in the API checks ownership; these constraints are the last line of defence.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ users
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique check (char_length(email) between 3 and 254),
  -- Null for accounts that only ever signed in with Google or GitHub.
  password_hash text,
  display_name text not null default '' check (char_length(display_name) <= 120),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  email_verified_at timestamptz,
  -- Bumped whenever the password changes, so outstanding reset tokens die with it.
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ------------------------------------------------------------------ sessions
-- Opaque, server-side sessions: the cookie holds a random 256-bit token, the database holds its
-- SHA-256. Revoking a row signs that device out on its very next request.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text check (char_length(ip) <= 64),
  user_agent text check (char_length(user_agent) <= 512)
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;

-- ------------------------------------------------------------------ email codes
-- One live 6-digit code per (email, purpose). Stored as HMAC(pepper, purpose|email|code).
create table email_codes (
  email citext not null,
  purpose text not null check (purpose in ('verify_email', 'reset_password', 'change_email')),
  code_hash bytea not null check (octet_length(code_hash) = 32),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (email, purpose)
);

-- ------------------------------------------------------------------ password reset grants
-- Issued after a correct reset code; lets one password change happen within a few minutes.
create table reset_grants (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ------------------------------------------------------------------ social sign-in
create table oauth_accounts (
  provider text not null check (provider in ('google', 'github')),
  provider_user_id text not null check (char_length(provider_user_id) <= 128),
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, provider_user_id)
);
create index oauth_accounts_user_idx on oauth_accounts (user_id);

-- ------------------------------------------------------------------ records
-- Every entity in config/entities.json lives here, with its fields as JSON validated on each write.
create table records (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity ~ '^[a-z][a-z0-9_]{0,47}$'),
  owner_id uuid not null references users (id) on delete cascade,
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 262144),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index records_owner_idx on records (entity, owner_id, created_at desc, id desc) where deleted_at is null;
create index records_public_idx on records (entity, created_at desc, id desc) where deleted_at is null and visibility = 'public';
create index records_data_idx on records using gin (data jsonb_path_ops);

-- ------------------------------------------------------------------ idempotency
create table idempotency_keys (
  owner_id uuid not null references users (id) on delete cascade,
  key text not null check (char_length(key) between 8 and 128),
  request_hash bytea not null,
  status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- ------------------------------------------------------------------ audit log (append only)
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null check (char_length(action) <= 64),
  target_type text check (char_length(target_type) <= 64),
  target_id text check (char_length(target_id) <= 128),
  ip text check (char_length(ip) <= 64),
  user_agent text check (char_length(user_agent) <= 512),
  request_id text check (char_length(request_id) <= 64),
  meta jsonb not null default '{}'::jsonb
);
create index audit_log_actor_idx on audit_log (actor_id, at desc);
create index audit_log_action_idx on audit_log (action, at desc);

-- ------------------------------------------------------------------ rate limits
-- Shared by every replica, unlike an in-memory counter. Keys are hashed by the app.
create unlogged table rate_limits (
  key text primary key check (char_length(key) <= 128),
  window_start timestamptz not null,
  hits integer not null
);

-- Counts one hit atomically and reports whether it is allowed, so parallel requests can't race past.
create function rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row rate_limits;
begin
  insert into rate_limits as r (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when r.window_start <= v_now - make_interval(secs => p_window_seconds) then v_now else r.window_start end,
        hits = case when r.window_start <= v_now - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end
  returning * into v_row;

  allowed := v_row.hits <= p_limit;
  remaining := greatest(p_limit - v_row.hits, 0);
  reset_at := v_row.window_start + make_interval(secs => p_window_seconds);
  return next;
end;
$$;

-- ------------------------------------------------------------------ housekeeping
create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_touch before update on users for each row execute function touch_updated_at();
create trigger records_touch before update on records for each row execute function touch_updated_at();
