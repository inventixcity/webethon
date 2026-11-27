-- Teams: shared workspaces with roles, email invites and soft-deleted teams.
--
-- Rules:
--   * A team has exactly one owner at a time. Ownership moves only through transfer, which runs under
--     a row lock on the team, so two requests can never leave a team without an owner.
--   * Invites store only a SHA-256 of the token, like sessions do.
--   * Soft-deleted teams are hidden everywhere; their rows stay for the audit trail.

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  -- Fixed at creation. Renaming changes the name only, so links built from the slug keep working.
  slug text not null unique check (char_length(slug) between 3 and 96),
  -- Kept when the creator's account is removed, so the team outlives them.
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index teams_live_idx on teams (id) where deleted_at is null;

create table team_members (
  team_id uuid not null references teams (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on team_members (user_id);
create index team_members_role_idx on team_members (team_id, role);
create index team_members_page_idx on team_members (team_id, joined_at, user_id);

create table team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  email citext not null check (char_length(email) between 3 and 254),
  -- Ownership is never granted by invite; it moves only through transfer.
  role text not null check (role in ('admin', 'member', 'viewer')),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  invited_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);
-- At most one live invite per address per team. Re-inviting revokes the old link first.
create unique index team_invites_pending_idx on team_invites (team_id, email)
  where accepted_at is null and revoked_at is null;
create index team_invites_team_idx on team_invites (team_id, created_at desc, id desc);
