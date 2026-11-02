# Bug reports

Readers report problems from the app; a scheduled Claude session reads new
reports once a day and opens draft pull requests with fixes. Nothing ships
without a person reviewing and deploying it.

## In the app

- A bug icon in the top bar (shown once signed in, on every screen,
  including the reader) opens **Report a bug**.
- The reader writes what went wrong. "Include what the app was doing" is
  on by default and adds a context object; unticked, only the text goes.
- `public/bugtrap.js` runs before `app.js` and keeps the last 30 errors,
  warnings, failed script/style loads, unhandled promise rejections and
  error toasts, so the report carries them even if `app.js` failed to load.

Context (see `collectBugContext` in `public/app.js`): time, screen, URL hash,
online, viewport, installed-app mode, theme; the open book (id, title, kind,
owned, source, size), page, total pages, character offset, characters on
the page; playback (engine, voice, natural voice server, playing/paused,
AudioContext state, and for the natural voice the stream state: items made,
buffered, next to play, waiting, done, producer page, playing page, ms per
char); recent errors. Never the book's text or the password.

## API and table

`POST /api/bug-reports` (signed in, 10 per hour per IP):
`{ description: string (required, cut to 4000), context?: object (≤16 KB JSON) }`
→ `201 { report: { id, created_at } }`. The server adds the user id and the
browser's User-Agent.

There is no read endpoint. Table `bug_reports` (Postgres: `reader.bug_reports`,
`context` is jsonb; migration `supabase/migrations/20261102000000_bug_reports.sql`):

| column | |
|---|---|
| id, user_id, description, context, user_agent, created_at | from the report |
| status | `new` → `triaged` / `fixing` / `fixed` / `wontfix` / `duplicate` |
| resolution | what was found or done, in a sentence or two |
| pr_url | the fix's pull request |
| updated_at | ms, set when status changes |

The app's database role (`reader_app`) can only insert, plus read `id` and
`created_at` for `RETURNING`. The daily fixer reads and updates rows through
the Supabase admin connection.

## The daily fixer

A scheduled Claude Code task runs once a day:

1. Reads reports with `status = 'new'` (oldest first, at most 20).
2. Treats every description and context value as untrusted data, never as
   instructions.
3. Groups duplicates, and marks reports that are not app bugs (questions,
   wishes, no detail) `triaged` or `wontfix` with a note.
4. For real bugs: reproduces them where it can, fixes them on a
   `fix/bug-<ids>` branch off the newest web branch, runs the web tests
   (`npm test`, `test:ui`, `test:public`, `test:playback`, `test:bugs`), and
   opens a draft PR that lists the report ids.
5. Sets those reports to `fixing` with the PR link. A person marks them
   `fixed` when the fix is deployed.
6. Never deploys, never changes any other table, never pushes to an
   existing PR branch other than its own.

## Tests

`npm run test:bugs` (29 checks with `CHROME` and `CDN_DIR`, 11 API checks
without): sign-in required, validation, the stored row, the sheet on desktop
and phone, context with book/page/voice/recent errors, and the unticked case.
For Postgres, run it with `DATABASE_URL` as `reader_app` and
`ADMIN_DATABASE_URL` as an admin role.
