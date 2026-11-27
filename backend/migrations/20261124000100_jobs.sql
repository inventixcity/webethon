create table jobs (
 id uuid primary key default gen_random_uuid(), kind text not null check (length(kind) between 1 and 100),
 payload jsonb not null check (octet_length(payload::text) <= 65536), run_at timestamptz not null default now(),
 attempts integer not null default 0 check (attempts >= 0), max_attempts integer not null default 8 check (max_attempts between 1 and 8),
 locked_until timestamptz, locked_by uuid, last_error text check (length(last_error) <= 256),
 status text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
 dedupe_key text check (dedupe_key is null or length(dedupe_key) between 1 and 200),
 created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index jobs_queued_dedupe on jobs (kind, dedupe_key) where status = 'queued' and dedupe_key is not null;
create index jobs_claim on jobs (run_at, created_at) where status in ('queued', 'running');
create table jobs_schedule_ticks (schedule_id text not null, tick timestamptz not null, primary key (schedule_id,tick));
create table jobs_schedule_state (schedule_id text primary key, last_tick timestamptz not null);
