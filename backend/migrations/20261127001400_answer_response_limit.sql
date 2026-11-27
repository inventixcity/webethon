-- A valid 20,000-character answer can occupy 80,000 UTF-8 bytes. Keep the storage
-- guard above that size; the API's shared validator enforces the character/word limits.
alter table answers drop constraint answers_response_check;
alter table answers add constraint answers_response_check
  check (pg_column_size(response) <= 131072);

-- 50,000 Unicode scratch characters plus a 400,000-character PNG data URL can
-- exceed the original 512 KiB guard while both fields remain contract-valid.
alter table attempt_scratch drop constraint attempt_scratch_content_check;
alter table attempt_scratch add constraint attempt_scratch_content_check
  check (pg_column_size(content) <= 786432);
