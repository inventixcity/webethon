create or replace function realtime_notify_record() returns trigger language plpgsql as $$
declare operation text;
begin
  operation := case when tg_op = 'INSERT' then 'insert'
    when old.deleted_at is null and new.deleted_at is not null then 'delete'
    else 'update' end;
  perform pg_notify('records_changed', json_build_object(
    'id', new.id, 'entity', new.entity, 'ownerId', new.owner_id,
    'teamId', new.team_id, 'visibility', new.visibility, 'version', new.version, 'op', operation
  )::text);
  return new;
end;
$$;
