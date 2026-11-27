alter table records add column admin_hidden_at timestamptz;
create index records_visible_public_idx on records (entity, created_at desc, id desc) where deleted_at is null and visibility = 'public' and admin_hidden_at is null;
