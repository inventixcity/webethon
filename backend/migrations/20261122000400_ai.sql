-- Reservations and settled usage share the UTC day on which the request began.
create table ai_usage (
    user_id uuid not null references users(id) on delete cascade,
    day date not null,
    requests integer not null default 0 check (requests >= 0),
    input_tokens bigint not null default 0 check (input_tokens >= 0),
    output_tokens bigint not null default 0 check (output_tokens >= 0),
    primary key (user_id, day)
);
