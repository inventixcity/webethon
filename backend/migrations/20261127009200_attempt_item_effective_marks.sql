create or replace function public.attempt_item_max_marks(p_attempt_id uuid, p_item_id uuid)
returns double precision
language sql
stable
set search_path = pg_catalog, public
as $$
    select case
        when i.id = any(a.item_order) and not i.voided
        then coalesce((a.item_marks ->> i.id::text)::double precision, i.marks::double precision)
        else null
    end
    from public.attempts a
    join public.exam_items i on i.exam_id = a.exam_id
    where a.id = p_attempt_id and i.id = p_item_id
$$;

revoke execute on function public.attempt_item_max_marks(uuid, uuid) from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke execute on function public.attempt_item_max_marks(uuid, uuid) from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke execute on function public.attempt_item_max_marks(uuid, uuid) from authenticated';
    end if;
end
$$;
