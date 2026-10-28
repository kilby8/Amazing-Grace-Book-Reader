-- Public library: where a book came from (a Find books result id for free
-- books, null for uploads), and the public books each reader saved to
-- their own shelf.
alter table reader.books add column if not exists source text;

create table if not exists reader.library_saves (
  user_id  bigint not null references reader.users(id) on delete cascade,
  book_id  bigint not null references reader.books(id) on delete cascade,
  saved_at bigint not null,
  primary key (user_id, book_id)
);
create index if not exists library_saves_book_idx on reader.library_saves(book_id);

grant select, insert, update, delete on reader.library_saves to reader_app;
