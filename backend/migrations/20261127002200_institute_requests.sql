create extension if not exists citext;
create table if not exists institute_requests (
 id uuid primary key default gen_random_uuid(), institute text not null, contact_name text not null, email citext not null,
 phone text, role text, expected_candidates integer, message text not null,
 status text not null default 'new' check(status in ('new','contacted','onboarded','declined')),
 ip_hash text not null, created_at timestamptz not null default now(), handled_by uuid references users(id), handled_at timestamptz,
 check(char_length(institute) between 2 and 160), check(char_length(contact_name) between 2 and 120), check(char_length(message) between 10 and 2000), check(expected_candidates is null or expected_candidates between 1 and 1000000)
);
alter table institute_requests enable row level security;
alter table institute_requests force row level security;
revoke all on institute_requests from anon, authenticated;
