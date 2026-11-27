create table http_request_stats (
    minute timestamptz not null,
    method text not null,
    route text not null,
    status smallint not null,
    count bigint not null check (count > 0),
    primary key (minute, method, route, status)
);
