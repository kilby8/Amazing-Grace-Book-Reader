# Public library

A shared shelf: any reader can put one of their books on it, and everyone
who is signed in can listen to it or save it to their own shelf.

## Control and criteria

Control: the Public library as it was before this change. Sharing was a
small lock icon on each cover (no label until a book was already public),
and the Public library tab was a bare grid: no way to share from it, no
search, no way to keep a book, no progress, and opening a shared book
dropped it as soon as you left the tab.

Rated on:

1. Sharing: steps to put a book on the public shelf, and whether a new
   reader can find how.
2. Keeping: can a reader keep a shared book, resume it later from My
   books / Continue listening, and drop it again.
3. Browsing: search, who shared it, your own progress, no duplicates.
4. Safety: only the owner can share or unshare; a saved book can't be
   used to delete or reshare the owner's file. (James chose "any book, no
   rights check" on 2026-10-27, so uploads share in one tap like free
   books.)
5. Fit: looks and behaves like the rest of the app (light/dark, phone).

## Data model

- `books.source` (new, nullable): the Find books result id
  (`gutenberg:2701`, `ia:<identifier>`) for books added from a free source.
  Uploads stay null. It marks a book as public domain and lets the shelf
  show one copy when two readers share the same free book.
- `library_saves` (new): `(user_id, book_id)` pk, `saved_at`. A reader's
  saved public books. Rows outlive a book going private again (the book
  just stops showing) and are removed with the book or user.

Postgres: `supabase/migrations/20261027000000_public_library.sql`, with
grants to `reader_app`. SQLite: idempotent migration in `db.js`.

## API

- `GET /api/public-books`: public books, newest share first, one per
  `source`. Each row adds `shared_by`, `mine` (caller owns it), `saved`,
  `free` (has a source), `saves` (how many readers kept it) and the
  caller's own `progress_page` / `progress_total_pages`.
- `POST /api/books/:id/visibility {visibility}`: owner only (unchanged).
- `POST /api/public-books/:id/save`, `DELETE /api/public-books/:id/save`:
  keep or drop a public book that isn't yours. Idempotent.
- `GET /api/books`: your books plus the public books you saved, the
  latter with `owned: false` and `shared_by`.
- `DELETE /api/books/:id` on a saved book removes the save, never the
  file.
- `POST /api/finder/add` stores the result id in `source`.

## UI

Public library tab:

- Header "Public library · N books" / "Books shared by everyone" and a
  primary **Share a book** button (icon-only on phones, like Add book).
- Search box (title, author, who shared it), filtered in the browser.
- Cover grid. Each card: cover, title, author, "Shared by X" (or "Shared
  by you"), a Free book badge, your progress bar if you've started it, and
  a corner action: **+ Save** / **Saved** for others' books, **Unshare**
  for yours. Tapping the cover opens it.
- Empty state: "Nothing shared yet" with a Share a book button.

Share a book sheet (same sheet style as Voice): every book you own, each
with a Share / Shared toggle and a Free book badge where it applies. One
tap shares or unshares.

My books: saved books appear with "From the public library · shared by X";
their corner action is Remove (from your shelf only, no file delete) and
they have no share toggle. The share toggle on your own books now always
shows its label (Share / Public).

## Files

- `db.js`, `supabase/migrations/20261027000000_public_library.sql`
- `server.js`: the routes above.
- `public/index.html`, `public/app.js`, `public/styles.css`
- `test-public.mjs` (new): API + browser checks.

## How it beats the control

Sharing goes from a hidden lock icon to a labelled button on the tab
itself (2 taps). Shared books can be kept, resumed from Continue
listening and searched, and duplicates of a free book collapse.

## Result (gauntlet, 2026-10-27)

Loop 1 passed both gates.

Gate A: `node test-public.mjs` 59/59 on SQLite and on Postgres 16 (the
three migrations applied in order, grants as in the first migration);
existing suites unchanged and green: test-progress 27/27, test-ui 39/39,
test-finder 81/81, test-playback 18/18. Screenshots checked at desktop and
phone width, light and dark.

Gate B (control → this):

| Criterion | Control | Now | Evidence |
| --- | --- | --- | --- |
| Sharing | 3 | 9 | Unlabelled lock icon on each cover vs a "Share a book" button on the tab (2 taps) and labelled Share pills |
| Keeping | 1 | 9 | No way to keep a shared book vs Save, shows on My books and Continue listening, Remove |
| Browsing | 4 | 8 | Bare grid vs search, count, your progress, saves count, one copy per free book |
| Safety | 7 | 8 | Owner-only sharing kept; saving can't unshare or delete the owner's file (tested) |
| Fit | 7 | 8 | Same cards, sheet and pills as the rest of the app; phone keeps the button's words |
