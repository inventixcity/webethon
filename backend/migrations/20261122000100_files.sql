create table files (
  id uuid primary key,
  owner_id uuid not null references users (id) on delete cascade,
  key text not null unique,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 bytea not null check (octet_length(sha256) = 32),
  width integer,
  height integer,
  original_name text check (original_name is null or char_length(original_name) <= 255),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index files_owner_idx on files (owner_id, created_at desc, id desc) where deleted_at is null;
