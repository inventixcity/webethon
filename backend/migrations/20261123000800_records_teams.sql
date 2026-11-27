alter table records add column team_id uuid references teams(id);
alter table records add constraint records_team_private check (team_id is null or visibility = 'private');
create index records_team_entity_idx on records (team_id, entity, created_at desc, id desc) where team_id is not null and deleted_at is null;
