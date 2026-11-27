create table social_comments (
 id uuid primary key default gen_random_uuid(), entity text not null, record_id uuid not null references records(id) on delete cascade,
 author_id uuid not null references users(id) on delete cascade, parent_id uuid references social_comments(id),
 body text not null check (char_length(body) between 1 and 2000), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), deleted_at timestamptz
);
create index social_comments_record_idx on social_comments(entity, record_id, created_at, id);
create table social_reactions (entity text not null, record_id uuid not null references records(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, kind text not null, created_at timestamptz not null default now(), primary key(record_id,user_id,kind));
create table social_bookmarks (entity text not null, record_id uuid not null references records(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, created_at timestamptz not null default now(), primary key(record_id,user_id));
create index social_bookmarks_user_idx on social_bookmarks(user_id, record_id);
create table social_follows (follower_id uuid not null references users(id) on delete cascade, followed_id uuid not null references users(id) on delete cascade, created_at timestamptz not null default now(), primary key(follower_id,followed_id), check(follower_id <> followed_id));
create table social_notifications (id uuid primary key default gen_random_uuid(), recipient_id uuid not null references users(id) on delete cascade, kind text not null, actor_id uuid references users(id) on delete set null, entity text, record_id uuid references records(id) on delete cascade, comment_id uuid references social_comments(id) on delete cascade, read_at timestamptz, created_at timestamptz not null default now());
create index social_notifications_recipient_idx on social_notifications(recipient_id, created_at desc, id desc);
create table social_activity (id uuid primary key default gen_random_uuid(), actor_id uuid references users(id) on delete set null, kind text not null, target_user_id uuid references users(id) on delete cascade, entity text, record_id uuid references records(id) on delete cascade, comment_id uuid references social_comments(id) on delete cascade, created_at timestamptz not null default now());
create index social_activity_created_idx on social_activity(created_at desc, id desc);
create function social_notify() returns trigger language plpgsql as $$ begin perform pg_notify('social_notifications', json_build_object('recipientId',new.recipient_id,'notificationId',new.id)::text); return new; end $$;
create trigger social_notification_insert after insert on social_notifications for each row execute function social_notify();
