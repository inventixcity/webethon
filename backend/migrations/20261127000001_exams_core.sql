-- Invigil examination schema.
--
-- Invariants (the API enforces them first; these constraints are the last line of defence):
--   * Answer keys live only in `questions.correct` and `exam_items.correct`. No candidate-facing query reads them
--     before results are published.
--   * A published exam's paper is frozen in `exam_items` (a snapshot). Editing the bank never changes a live paper.
--   * Timing is server-side: `attempts.deadline_at` is computed by the server when the attempt starts and only
--     moves by an audited `time_credits` row.
--   * One real attempt per candidate per exam (partial unique index). Sandbox attempts never count.

-- ------------------------------------------------------------------ roles
-- `user` remains the stored value for candidates so existing code keeps working; the API presents it as `candidate`.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('user', 'examiner', 'admin'));

-- Per-user exam workspace preferences (4.7). Small JSON document, validated by the API.
create table workspace_prefs (
  user_id uuid primary key references users (id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb check (pg_column_size(prefs) <= 4096),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ invites (provisioned accounts)
-- An invite lets a provisioned account set its first password. Only the SHA-256 of the token is stored.
create table account_invites (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references users (id) on delete cascade,
  invited_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index account_invites_user_idx on account_invites (user_id) where used_at is null;

-- ------------------------------------------------------------------ question bank
create table questions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete restrict,
  topic text not null check (char_length(topic) between 1 and 80),
  difficulty smallint not null check (difficulty between 1 and 5),
  kind text not null check (kind in ('single', 'multi', 'written')),
  stem text not null check (char_length(stem) between 1 and 4000),
  -- [{ "id": "a", "text": "..." }] for objective kinds, [] for written.
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 10),
  -- Answer key: array of option ids. [] for written. NEVER returned to candidates.
  correct jsonb not null default '[]'::jsonb check (jsonb_typeof(correct) = 'array'),
  marks numeric(6, 2) not null check (marks > 0 and marks <= 1000),
  -- Marks deducted for a wrong objective answer (0 = no negative marking). Skipped answers never lose marks.
  negative_marks numeric(6, 2) not null default 0 check (negative_marks >= 0 and negative_marks <= marks),
  -- multi-select rule: all_or_nothing | partial (per correct option, no credit if any wrong option chosen)
  --                    | partial_penalty (+per correct, -per wrong, floored at 0)
  multi_rule text not null default 'all_or_nothing' check (multi_rule in ('all_or_nothing', 'partial', 'partial_penalty')),
  rubric text not null default '' check (char_length(rubric) <= 4000),
  max_words integer check (max_words is null or max_words between 1 and 5000),
  explanation text not null default '' check (char_length(explanation) <= 4000),
  -- Observed difficulty from real attempts (facility index 0..1), refreshed by analytics.
  observed_facility numeric(5, 4),
  observed_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (
    (kind = 'written' and jsonb_array_length(options) = 0 and jsonb_array_length(correct) = 0)
    or (kind = 'single' and jsonb_array_length(options) >= 2 and jsonb_array_length(correct) = 1)
    or (kind = 'multi' and jsonb_array_length(options) >= 2 and jsonb_array_length(correct) >= 1)
  )
);
create index questions_owner_idx on questions (owner_id, created_at desc) where deleted_at is null;
create index questions_topic_idx on questions (owner_id, topic) where deleted_at is null;

-- ------------------------------------------------------------------ exams
create table exams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  -- Stored lifecycle. `ongoing` is derived: published and now() within [starts_at, ends_at).
  status text not null default 'draft' check (status in ('draft', 'published', 'completed', 'archived')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  total_marks numeric(8, 2) not null check (total_marks > 0 and total_marks <= 100000),
  pass_marks numeric(8, 2) not null default 0 check (pass_marks >= 0),
  -- { shuffleQuestions, shuffleOptions, allowOfflineJournal, integrity: { watermark, canary, fullscreen },
  --   showBreakdown, lateJoinMinutes }  validated by the API.
  settings jsonb not null default '{}'::jsonb check (pg_column_size(settings) <= 4096),
  published_at timestamptz,
  results_published_at timestamptz,
  completed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ends_at > starts_at),
  check (pass_marks <= total_marks),
  check (results_published_at is null or published_at is not null)
);
create index exams_owner_idx on exams (owner_id, starts_at desc) where deleted_at is null;
create index exams_window_idx on exams (status, starts_at, ends_at) where deleted_at is null;

-- Draft assignment: which bank questions belong to an exam (editable while draft).
create table exam_questions (
  exam_id uuid not null references exams (id) on delete cascade,
  question_id uuid not null references questions (id) on delete restrict,
  position integer not null check (position >= 0),
  -- Optional per-exam override of the question's marks.
  marks numeric(6, 2) check (marks is null or (marks > 0 and marks <= 1000)),
  primary key (exam_id, question_id)
);
create unique index exam_questions_position_idx on exam_questions (exam_id, position);

-- Frozen paper: written once at publish (or for a draft sandbox run). Attempts reference these rows only.
create table exam_items (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams (id) on delete cascade,
  question_id uuid references questions (id) on delete set null,
  -- Sandbox runs of a draft get their own snapshot so they never touch the real paper.
  sandbox boolean not null default false,
  position integer not null check (position >= 0),
  topic text not null,
  difficulty smallint not null,
  kind text not null check (kind in ('single', 'multi', 'written')),
  stem text not null,
  options jsonb not null,
  correct jsonb not null,
  marks numeric(6, 2) not null check (marks > 0),
  negative_marks numeric(6, 2) not null default 0,
  multi_rule text not null,
  rubric text not null default '',
  max_words integer,
  explanation text not null default '',
  created_at timestamptz not null default now()
);
create index exam_items_exam_idx on exam_items (exam_id, sandbox, position);

-- ------------------------------------------------------------------ enrollment
create table enrollments (
  exam_id uuid not null references exams (id) on delete cascade,
  candidate_id uuid not null references users (id) on delete cascade,
  status text not null default 'enrolled' check (status in ('enrolled', 'revoked')),
  -- Accessibility accommodation (extra minutes), set by the examiner, audited.
  extra_minutes integer not null default 0 check (extra_minutes between 0 and 600),
  enrolled_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (exam_id, candidate_id)
);
create index enrollments_candidate_idx on enrollments (candidate_id) where status = 'enrolled';

-- ------------------------------------------------------------------ attempts
create table attempts (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams (id) on delete cascade,
  candidate_id uuid not null references users (id) on delete cascade,
  sandbox boolean not null default false,
  -- in_progress -> submitted (by candidate) | expired (deadline passed; finalized by server)
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'expired')),
  finalized_by text check (finalized_by in ('candidate', 'timer', 'examiner')),
  started_at timestamptz not null default now(),
  -- Authoritative. min(started_at + duration + extra_minutes, exam.ends_at) + sum(time_credits).
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  -- Deterministic per-attempt randomisation.
  seed bigint not null,
  item_order uuid[] not null,
  -- { "<item id>": ["c","a","b"] } option display order per item.
  option_order jsonb not null default '{}'::jsonb,
  -- Device lock (5.1/5.3): only this device may write; a takeover moves it and records an incident.
  active_device text check (char_length(active_device) <= 64),
  device_changed_at timestamptz,
  last_heartbeat_at timestamptz,
  -- Offline journal (5.3): server-side head of the hash chain, and the random genesis value.
  journal_genesis bytea not null check (octet_length(journal_genesis) = 32),
  journal_head bytea check (journal_head is null or octet_length(journal_head) = 32),
  journal_seq bigint not null default 0,
  -- Grading state.
  auto_score numeric(8, 2),
  manual_score numeric(8, 2),
  total_score numeric(8, 2),
  grading_status text not null default 'pending' check (grading_status in ('pending', 'partial', 'complete')),
  -- Integrity review priority computed from indicators (never a verdict).
  review_priority text not null default 'none' check (review_priority in ('none', 'low', 'medium', 'high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Prevents duplicate real attempts even under concurrent "start" requests.
create unique index attempts_one_real_idx on attempts (exam_id, candidate_id) where not sandbox;
create index attempts_exam_idx on attempts (exam_id, status) where not sandbox;
create index attempts_deadline_idx on attempts (deadline_at) where status = 'in_progress';
create index attempts_candidate_idx on attempts (candidate_id, created_at desc);

create table answers (
  attempt_id uuid not null references attempts (id) on delete cascade,
  item_id uuid not null references exam_items (id) on delete cascade,
  -- { "selected": ["a"] } or { "text": "..." }. Empty selection / empty text = skipped.
  response jsonb not null check (pg_column_size(response) <= 65536),
  flagged boolean not null default false,
  -- Monotonic client sequence number: a save with a lower or equal seq is ignored (idempotent, ordered).
  client_seq bigint not null check (client_seq >= 0),
  -- 'online' (saved live) or 'journal' (synced from the offline journal after reconnect).
  source text not null default 'online' check (source in ('online', 'journal')),
  -- Server receipt time and the time the answer was written (equal for online saves; lease-derived for journal).
  saved_at timestamptz not null default now(),
  written_at timestamptz not null default now(),
  -- Keystroke/paste telemetry for written answers (counts only, never keystroke content).
  typing jsonb not null default '{}'::jsonb check (pg_column_size(typing) <= 2048),
  auto_marks numeric(6, 2),
  manual_marks numeric(6, 2),
  feedback text not null default '' check (char_length(feedback) <= 4000),
  graded_by uuid references users (id) on delete set null,
  graded_at timestamptz,
  primary key (attempt_id, item_id)
);

-- Rough work (4.8). One document per attempt: text and an optional compressed sketch.
create table attempt_scratch (
  attempt_id uuid primary key references attempts (id) on delete cascade,
  content jsonb not null default '{}'::jsonb check (pg_column_size(content) <= 524288),
  updated_at timestamptz not null default now()
);

-- Audited extra time for a server-verified outage (5.3). Never granted automatically.
create table time_credits (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts (id) on delete cascade,
  seconds integer not null check (seconds between 1 and 3600),
  reason text not null check (char_length(reason) between 3 and 500),
  -- The verified outage window this credit compensates, from heartbeat gaps.
  outage_from timestamptz,
  outage_to timestamptz,
  granted_by uuid not null references users (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index time_credits_attempt_idx on time_credits (attempt_id);

-- Heartbeats are summarised as connectivity windows so outages can be verified server-side.
create table attempt_heartbeats (
  attempt_id uuid not null references attempts (id) on delete cascade,
  at timestamptz not null default now(),
  online boolean not null default true,
  pending integer not null default 0 check (pending >= 0),
  primary key (attempt_id, at)
);

-- ------------------------------------------------------------------ monitoring and integrity (3.6, 5.1)
create table attempt_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references attempts (id) on delete cascade,
  kind text not null check (kind in (
    'started', 'resumed', 'submitted', 'expired',
    'focus_lost', 'visibility_hidden', 'fullscreen_exit', 'paste', 'copy', 'context_menu',
    'typing_anomaly', 'canary_hit', 'device_takeover', 'second_device',
    'offline', 'online', 'journal_synced', 'journal_rejected', 'time_credit',
    'announcement_seen', 'speed_anomaly', 'similarity'
  )),
  severity text not null default 'info' check (severity in ('info', 'notice', 'warning')),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 2048),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 86400000),
  client_at timestamptz,
  recorded_at timestamptz not null default now()
);
create index attempt_events_attempt_idx on attempt_events (attempt_id, id);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams (id) on delete cascade,
  author_id uuid not null references users (id) on delete restrict,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index announcements_exam_idx on announcements (exam_id, created_at);

-- ------------------------------------------------------------------ verifiable results (4.6)
-- One signed statement per attempt when results are published. The public verify endpoint returns only
-- the minimal, masked facts in `statement`.
create table result_certificates (
  attempt_id uuid primary key references attempts (id) on delete cascade,
  verify_code text not null unique check (char_length(verify_code) between 10 and 32),
  statement jsonb not null,
  statement_hash bytea not null check (octet_length(statement_hash) = 32),
  signature bytea not null check (octet_length(signature) = 64),
  key_id text not null,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ------------------------------------------------------------------ hardening for hosted Postgres
-- Supabase exposes the public schema through PostgREST. The API connects as the table owner, so enabling RLS
-- with no policies (and revoking grants) blocks the anon/authenticated roles without affecting the API.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
  end if;
end $$;
