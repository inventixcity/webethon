-- Delivery state contains no response body, signing secret, or request headers.
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2048),
  description text check (char_length(description) <= 500),
  events text[] not null check (cardinality(events) between 1 and 32),
  secret_ciphertext bytea not null,
  active boolean not null default true,
  failure_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhooks_owner_idx on webhooks(owner_id, created_at desc, id desc);
create trigger webhooks_touch before update on webhooks for each row execute function touch_updated_at();

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references webhooks(id) on delete cascade,
  event_id uuid not null,
  status text not null check (status in ('pending', 'delivered', 'failed')),
  response_code integer check (response_code between 100 and 599),
  duration_ms integer check (duration_ms >= 0),
  attempt integer not null default 0 check (attempt >= 0),
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (webhook_id, event_id)
);
create index webhook_deliveries_list_idx on webhook_deliveries(webhook_id, created_at desc, id desc);
create trigger webhook_deliveries_touch before update on webhook_deliveries for each row execute function touch_updated_at();
