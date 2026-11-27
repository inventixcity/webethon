-- Payments: Stripe checkout, signed webhooks, purchases and entitlements.
-- Stripe is the source of truth for money. These rows hold what Stripe confirmed, and every webhook
-- re-reads its object from Stripe before anything changes.

-- Every webhook event we have accepted. The primary key makes replays no-ops.
create table payment_events (
  id text primary key check (char_length(id) between 1 and 255),
  event_type text not null check (char_length(event_type) between 1 and 128),
  livemode boolean not null,
  received_at timestamptz not null default now(),
  -- Null until processing succeeded. A redelivery of an unprocessed event is processed again.
  processed_at timestamptz
);

-- One-off payments and first subscription invoices. Keyed by Stripe's object id, so a re-delivered
-- event can't record the same payment twice.
create table purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  product_id text not null check (char_length(product_id) between 1 and 64),
  stripe_object_id text not null unique check (char_length(stripe_object_id) between 1 and 255),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  created_at timestamptz not null default now()
);
create index purchases_user_idx on purchases (user_id, created_at desc, id desc);

-- What a user may access. Status and period end mirror Stripe; a one-off purchase is 'active' with no end.
create table entitlements (
  user_id uuid not null references users (id) on delete cascade,
  product_id text not null check (char_length(product_id) between 1 and 64),
  status text not null check (char_length(status) between 1 and 32),
  current_period_end timestamptz,
  stripe_customer_id text check (char_length(stripe_customer_id) <= 255),
  stripe_subscription_id text check (char_length(stripe_subscription_id) <= 255),
  -- When Stripe was read. An older read never overwrites a newer one, even if the webhooks race.
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
