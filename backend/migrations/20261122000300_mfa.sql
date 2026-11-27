create table mfa_totp (
  user_id uuid primary key references users (id) on delete cascade,
  secret_ciphertext bytea not null,
  secret_nonce bytea not null,
  enabled_at timestamptz,
  last_used_step bigint,
  created_at timestamptz not null default now()
);

create table mfa_recovery_codes (
  user_id uuid not null references users (id) on delete cascade,
  code_hash bytea not null,
  used_at timestamptz,
  primary key (user_id, code_hash)
);

create table mfa_challenges (
  token_hash bytea primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz
);
