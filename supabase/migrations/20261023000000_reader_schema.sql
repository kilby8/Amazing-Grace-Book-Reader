-- Amazing Grace Reader: hosted schema (Supabase Postgres + Storage).
-- Applied to the Supabase project the live site uses. The local server
-- uses SQLite instead and creates its own tables (see web/db.js).
--
-- The app connects as its own login role, reader_app, whose
-- search_path is `reader`. That role is created outside migrations so its
-- password never lands in migration history:
--
--   create role reader_app login password '<secret>' noinherit;
--   alter role reader_app set search_path = reader;
--   grant usage on schema reader to reader_app;
--   grant select, insert, update, delete on all tables in schema reader to reader_app;
--   grant usage, select on all sequences in schema reader to reader_app;
--   grant usage on schema storage to reader_app;
--   grant select on storage.objects to reader_app;
--   create policy "books: app server reads metadata" on storage.objects
--     for select to reader_app using (bucket_id = 'books');

-- App data lives in its own schema, which PostgREST does not expose.
create schema if not exists reader;

create table reader.users (
  id            bigserial primary key,
  username      text unique not null,
  password_hash text not null,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table reader.books (
  id             bigserial primary key,
  user_id        bigint not null references reader.users(id) on delete cascade,
  title          text not null,
  author         text,
  kind           text not null check (kind in ('pdf','epub')),
  filename       text not null,
  size           bigint not null,
  added_at       bigint not null default (extract(epoch from now()) * 1000)::bigint,
  last_opened_at bigint,
  visibility     text not null default 'private' check (visibility in ('private','public')),
  shared_at      bigint
);
create index books_user_id_idx on reader.books(user_id);
create index books_public_shared_idx on reader.books(visibility, shared_at desc) where visibility = 'public';

create table reader.reading_progress (
  user_id     bigint not null references reader.users(id) on delete cascade,
  book_id     bigint not null references reader.books(id) on delete cascade,
  page        integer not null,
  char_offset integer not null default 0,
  total_pages integer,
  updated_at  bigint not null,
  primary key (user_id, book_id)
);

create table reader.sessions (
  sid     text primary key,
  sess    text not null,
  expires bigint not null
);
create index sessions_expires_idx on reader.sessions(expires);

-- Short-lived capabilities for Supabase Storage. The server records a ticket
-- for one object path; storage policies let the anon key act on that path
-- only while a matching ticket is live.
create table reader.storage_tickets (
  object_path text not null,
  purpose     text not null check (purpose in ('upload','read','delete')),
  expires_at  timestamptz not null,
  primary key (object_path, purpose)
);

create or replace function reader.storage_ticket_ok(p_name text, p_purposes text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from reader.storage_tickets t
    where t.object_path = p_name
      and t.purpose = any (p_purposes)
      and t.expires_at > now()
  );
$$;
revoke all on function reader.storage_ticket_ok(text, text[]) from public;
grant usage on schema reader to anon, authenticated;
grant execute on function reader.storage_ticket_ok(text, text[]) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('books', 'books', false, 52428800,
        array['application/pdf','application/epub+zip','application/octet-stream'])
on conflict (id) do nothing;

create policy "books: upload with ticket" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'books' and reader.storage_ticket_ok(name, array['upload']));
create policy "books: read with ticket" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'books' and reader.storage_ticket_ok(name, array['upload','read','delete']));
create policy "books: delete with ticket" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'books' and reader.storage_ticket_ok(name, array['delete']));
