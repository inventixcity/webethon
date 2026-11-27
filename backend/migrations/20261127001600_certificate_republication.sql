-- Keep revoked certificate rows for public verification while allowing a new active certificate
-- to be issued when an examiner republishes results.
alter table result_certificates drop constraint result_certificates_pkey;
alter table result_certificates add column id uuid not null default gen_random_uuid();
alter table result_certificates add primary key (id);

create unique index result_certificates_active_attempt_idx
  on result_certificates (attempt_id)
  where revoked_at is null;
