create table admin_step_up (
 session_id uuid primary key references sessions(id) on delete cascade,
 expires_at timestamptz not null,
 password_changed_at timestamptz,
 password_hash_snapshot bytea,
 mfa_snapshot bytea
);
