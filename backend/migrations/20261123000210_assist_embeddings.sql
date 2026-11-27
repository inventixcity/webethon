create extension if not exists vector;
create table assist_embedding_models (model text primary key, dimensions integer not null check (dimensions between 1 and 2000));
create table assist_embeddings (
 record_id uuid primary key references records(id) on delete cascade,
 model text not null references assist_embedding_models(model), dimensions integer not null,
 record_version integer not null, embedding vector not null
);
create table assist_embedding_queue (
 record_id uuid primary key references records(id) on delete cascade,
 generation bigint not null default 1, attempts integer not null default 0,
 available_at timestamptz not null default now(), lease_until timestamptz,
 last_error text
);
create function assist_enqueue_embedding() returns trigger language plpgsql as $$
begin
 if new.deleted_at is not null then
   delete from assist_embeddings where record_id = new.id;
   delete from assist_embedding_queue where record_id = new.id;
 else
   delete from assist_embeddings where record_id = new.id;
   insert into assist_embedding_queue(record_id) values(new.id)
   on conflict(record_id) do update set generation=assist_embedding_queue.generation+1,
     attempts=0, available_at=now(), lease_until=null, last_error=null;
 end if;
 return new;
end $$;
create trigger assist_records_enqueue after insert or update on records for each row execute function assist_enqueue_embedding();
insert into assist_embedding_queue(record_id) select id from records where deleted_at is null;
