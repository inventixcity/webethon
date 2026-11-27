-- Search only configured top-level string fields, in configured order.
create function records_search_vector(doc jsonb, fields text[]) returns tsvector
language sql immutable parallel safe as $$
  select to_tsvector('english'::regconfig, coalesce(string_agg(
    case when jsonb_typeof(doc -> field) = 'string' then doc ->> field else '' end,
    ' ' order by ord), ''))
  from unnest(fields) with ordinality as f(field, ord)
$$;

create index records_notes_search_idx on records using gin
  (records_search_vector(data, array['title', 'body']::text[]))
  where entity = 'notes' and deleted_at is null;
create index records_tasks_search_idx on records using gin
  (records_search_vector(data, array['title']::text[]))
  where entity = 'tasks' and deleted_at is null;
