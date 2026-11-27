do $$
declare
    role_name text;
begin
    execute 'revoke execute on all functions in schema public from public';
    foreach role_name in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = role_name) then
            execute format('revoke execute on all functions in schema public from %I', role_name);
        end if;
    end loop;
end
$$;

alter default privileges in schema public revoke execute on functions from public;
do $$
declare
    role_name text;
begin
    foreach role_name in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = role_name) then
            execute format('alter default privileges in schema public revoke execute on functions from %I', role_name);
        end if;
    end loop;
end
$$;
