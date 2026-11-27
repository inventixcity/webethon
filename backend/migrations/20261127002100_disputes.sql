-- 5.4 candidate disputes and examiner resolutions.
alter table exam_items add column if not exists voided boolean not null default false;
alter table exam_items add column if not exists accepted_alternatives jsonb not null default '[]'::jsonb
  check (jsonb_typeof(accepted_alternatives) = 'array');
alter table attempts add column if not exists item_marks jsonb not null default '{}'::jsonb;

create table if not exists disputes (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  item_id uuid not null references exam_items(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  reason text not null check (char_length(reason) between 10 and 2000),
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  resolution text not null default 'none' check (resolution in ('none','regrade','void_item','accept_alternative')),
  response text not null default '' check (char_length(response) <= 2000),
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  score_before numeric(8,2),
  score_after numeric(8,2),
  created_at timestamptz not null default now(),
  unique(attempt_id,item_id)
);
create index if not exists disputes_candidate_idx on disputes(candidate_id,created_at desc);
create index if not exists disputes_item_idx on disputes(item_id,status);
alter table disputes enable row level security;
