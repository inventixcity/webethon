-- Hosted Postgres lockdown, run after every feature migration (worker ranges end at 20261127001899).
--
-- The exam schema migration enabled row level security only on the tables that existed when it ran. This sweep
-- repeats it for every table in `public` (including any a later feature migration created), and changes the
-- default privileges so a table created after this point is not readable by the PostgREST roles even before RLS
-- is turned on for it. The API connects as the table owner, which RLS without policies does not restrict.
-- Every statement is a no-op on a plain local Postgres where the `anon` and `authenticated` roles don't exist.
do $$
declare t record;
declare r text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke execute on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke execute on functions from %I', r);
    end if;
  end loop;
end $$;
