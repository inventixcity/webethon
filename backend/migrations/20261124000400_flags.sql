create table feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  description text not null check (char_length(description) <= 500),
  enabled boolean not null,
  rollout smallint not null check (rollout between 0 and 100),
  allow_emails text[] not null default '{}',
  allow_teams uuid[] not null default '{}',
  value jsonb,
  check (cardinality(allow_emails) <= 100 and cardinality(allow_teams) <= 100),
  check (value is null or octet_length(value::text) <= 8192)
);
