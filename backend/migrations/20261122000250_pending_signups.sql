-- Credentials belong to a challenge until the mailbox owner verifies it.
create table pending_signups (
  id uuid primary key default gen_random_uuid(),
  email citext not null check (char_length(email) between 3 and 254),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  code_hash bytea not null check (octet_length(code_hash) = 32),
  password_hash text not null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  code_sent_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index pending_signups_email_idx on pending_signups(email, created_at);
