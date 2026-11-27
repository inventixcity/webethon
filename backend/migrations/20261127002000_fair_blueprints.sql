-- Fair randomized paper blueprints (5.2).
create table exam_blueprints (
  exam_id uuid primary key references exams(id) on delete cascade,
  enabled boolean not null default false,
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  tolerance numeric(4,3) not null default 0.05 check (tolerance between 0.010 and 0.300),
  updated_at timestamptz not null default now()
);

alter table exam_items add column predicted_facility numeric(5,4);
alter table attempts add column predicted_facility numeric(5,4);
alter table attempts add column item_marks jsonb not null default '{}'::jsonb
  check (jsonb_typeof(item_marks) = 'object' and pg_column_size(item_marks) <= 16384);

alter table exam_blueprints enable row level security;
revoke all on exam_blueprints from anon, authenticated;
