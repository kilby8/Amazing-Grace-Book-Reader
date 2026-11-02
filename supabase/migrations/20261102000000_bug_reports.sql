-- Bug reports from the "Report a bug" sheet. The app only adds rows; the
-- daily bug fixer (web/BUG_REPORTS.md) reads and updates them with the
-- project's admin connection, so reader_app gets INSERT and just enough
-- SELECT for RETURNING id, created_at.
create table if not exists reader.bug_reports (
  id          bigserial primary key,
  user_id     bigint references reader.users(id) on delete set null,
  description text not null,
  context     jsonb,
  user_agent  text,
  created_at  bigint not null,
  status      text not null default 'new'
              check (status in ('new','triaged','fixing','fixed','wontfix','duplicate')),
  resolution  text,
  pr_url      text,
  updated_at  bigint
);
create index if not exists bug_reports_status_idx on reader.bug_reports(status, created_at);

grant insert on reader.bug_reports to reader_app;
grant select (id, created_at) on reader.bug_reports to reader_app;
grant usage on sequence reader.bug_reports_id_seq to reader_app;
