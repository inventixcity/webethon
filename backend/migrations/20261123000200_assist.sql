-- Proposed writes remain inert until claimed and applied in the same transaction.
create table assist_pending_actions (
  action_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('create_record', 'update_record')),
  entity text not null check (entity ~ '^[a-z][a-z0-9_]{0,47}$'),
  record_id uuid,
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 262144),
  version integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  cancelled_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check ((kind = 'create_record' and record_id is null and version is null) or
         (kind = 'update_record' and record_id is not null and version is not null and version > 0)),
  check (consumed_at is null or cancelled_at is null)
);
create index assist_pending_actions_user_idx on assist_pending_actions (user_id, expires_at)
  where consumed_at is null and cancelled_at is null;

