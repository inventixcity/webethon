-- One outbox serves all record events. The op column picks the event name at delivery time.
-- Existing rows are all creations, so the default keeps them correct.
alter table webhook_record_outbox add column op text not null default 'created' check (op in ('created', 'updated', 'deleted'));

-- Soft delete is an UPDATE (deleted_at is set), so it is announced here as 'deleted' rather than 'updated'.
create function webhook_record_updated() returns trigger language plpgsql as $$
begin
  insert into webhook_record_outbox(record_id,entity,owner_id,team_id,created_at,op)
  values(new.id,new.entity,new.owner_id,new.team_id,clock_timestamp(),
    case when new.deleted_at is not null and old.deleted_at is null then 'deleted' else 'updated' end);
  return new;
end $$;
-- Only changes that a subscriber can see produce an event; version-only and timestamp-only writes do not.
create trigger webhook_record_updated after update on records for each row
  when (old.data is distinct from new.data
    or old.visibility is distinct from new.visibility
    or old.team_id is distinct from new.team_id
    or old.deleted_at is distinct from new.deleted_at
    or old.admin_hidden_at is distinct from new.admin_hidden_at)
  execute function webhook_record_updated();

-- A hard delete of a record that was already soft-deleted was announced already, so it is skipped.
create function webhook_record_deleted() returns trigger language plpgsql as $$
begin
  if old.deleted_at is null then
    insert into webhook_record_outbox(record_id,entity,owner_id,team_id,created_at,op)
    values(old.id,old.entity,old.owner_id,old.team_id,clock_timestamp(),'deleted');
  end if;
  return old;
end $$;
create trigger webhook_record_deleted after delete on records for each row execute function webhook_record_deleted();
