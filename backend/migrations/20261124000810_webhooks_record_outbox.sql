-- Keep only routing metadata; record data is loaded under current permissions at delivery time.
create table webhook_record_outbox (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null,
  entity text not null,
  owner_id uuid not null,
  team_id uuid,
  created_at timestamptz not null,
  processed_at timestamptz
);
create index webhook_record_outbox_pending_idx on webhook_record_outbox(created_at,id) where processed_at is null;
create function webhook_record_created() returns trigger language plpgsql as $$
begin
  insert into webhook_record_outbox(record_id,entity,owner_id,team_id,created_at)
  values(new.id,new.entity,new.owner_id,new.team_id,new.created_at);
  return new;
end $$;
create trigger webhook_record_created after insert on records for each row execute function webhook_record_created();
