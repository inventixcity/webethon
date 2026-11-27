-- records_data_idx (GIN jsonb_path_ops) only serves `@>` containment, and no query uses it: record
-- filters compare one key with `->` and `=`. It costs write time and disk on every record, so drop it.
drop index if exists records_data_idx;
