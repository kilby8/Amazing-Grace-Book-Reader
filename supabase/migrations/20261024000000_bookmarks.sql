-- Bookmarks: a reader's saved places in a book (same page + char_offset
-- model as reading_progress), with an optional note.
create table reader.bookmarks (
  id          bigserial primary key,
  user_id     bigint not null references reader.users(id) on delete cascade,
  book_id     bigint not null references reader.books(id) on delete cascade,
  page        integer not null,
  char_offset integer not null default 0,
  note        text,
  created_at  bigint not null
);
create index bookmarks_user_book_idx on reader.bookmarks(user_id, book_id);

-- "grant ... on all tables" in the first migration only covered tables that
-- existed then.
grant select, insert, update, delete on reader.bookmarks to reader_app;
grant usage, select on sequence reader.bookmarks_id_seq to reader_app;
