# Book finder

A search bar that looks across free, legal book sources and adds a result
to the reader's library in one tap.

## Control and criteria

Control: today's route to a free classic. Leave the app, search
gutenberg.org, download the EPUB, come back, press Add book, pick the file
(about 8 steps across two sites; on a phone it also means the Files app).

Rated on:

1. Steps from a query to listening.
2. Relevance: the book you meant is in the top 3 for common title/author
   queries.
3. Safety: only public-domain / openly licensed sources; the server never
   fetches a URL the browser chose.
4. Reliability: one slow or broken source doesn't break search.
5. Fit: looks and behaves like the rest of the app (light/dark, phone).

## Sources

| Source | Search | File | Why |
| --- | --- | --- | --- |
| Project Gutenberg | `gutenberg.org/ebooks/search.opds/?query=` (Atom, ranked by popularity) | `/ebooks/<n>.epub3.images`, falls back to `.epub.images` | ~75k proofread public-domain books; clean text reads best aloud |
| Internet Archive | `archive.org/advancedsearch.php`, texts only, excluding lending (`inlibrary`), print-disabled and access-restricted items | `/metadata/<id>` picks the "Text PDF" (has a text layer) if it fits under the upload cap, otherwise the EPUB | Scanned public-domain editions, real PDFs |

Not used: Gutendex (Cloudflare challenge blocks server requests), Standard
Ebooks (doesn't answer requests from Vercel's network; its books are
Gutenberg texts anyway), Open Library (its public scans are the same
Internet Archive items). Nothing from shadow libraries.

## Files

- `finder.js` (new): source adapters, `search(q)`, `resolveDownload(id)`,
  `download(id)`.
- `storage.js`: `putObject(userId, filename, buffer)` for server-side
  writes to Supabase Storage (same ticket mechanism as browser uploads).
- `server.js`: `GET /api/finder/search?q=`, `POST /api/finder/add {id}`,
  CSP `img-src` gains the two cover hosts.
- `vercel.json`: same CSP change. The live site's deploy kit has its own
  `vercel.json`, which needs the same `img-src` and `finder.js` in
  `includeFiles`.
- `public/index.html`, `public/app.js`, `public/styles.css`: a "Find books"
  tab and screen.
- `test-finder.mjs`, `test-finder-fixtures.cjs` (new): tests against
  recorded source answers (finder, API and browser), plus `--live` mode
  that asks the real sources.

## Data model

Search result:

```
{ id: "gutenberg:2701" | "ia:<identifier>", source: "gutenberg" | "ia",
  sourceName, title, author, year, kind: "epub" | "pdf", cover, pageUrl,
  downloads }
```

No schema change. An added book is an ordinary `books` row (title and
author come from the source, so the library shows them properly).

## Safety

- The browser only sends a result id. The server validates it
  (`gutenberg:\d+`, `ia:[A-Za-z0-9._-]+`) and builds the URL itself, so
  there is no SSRF.
- Redirects are followed manually and only to `gutenberg.org`,
  `archive.org` and `*.archive.org`.
- Downloads stop at the 50 MB cap, and the first bytes must be `%PDF` or a
  ZIP header.
- Both routes need a login; search is limited to 30/min and add to 10/min
  per IP.

## Flow

Search runs both sources in parallel, each with a 9 s timeout. Results are
ordered by how well title and author match the query, then each source's
own popularity order, with Gutenberg winning ties because its proofread
text reads better aloud than a scan's OCR. Within a source, repeat
editions of one book collapse to the most popular one (separate volumes
stay separate). The same book can appear once from each source, so the
reader can pick the EPUB or the scanned PDF. A source that fails is
reported with `ok: false` in the response, and the rest still show.

Add: the server downloads the file (Vercel caps request/response bodies at
4.5 MB, so it can't round-trip through the browser), writes it to storage,
inserts the row and returns the book. The browser puts it on the shelf and
the result's button turns into "Open".

## UI

The library's segmented control becomes My books / Find books / Public.
Find books is a screen with one large search field, source chips, and a
result list: cover, title, author, year, source and format badge, and an
Add button that turns into a spinner, then Open. A library search with no
matches offers "Search free books for '<query>'". The empty shelf offers
the same.

Beats the control: query to listening in 3 taps (type, Add, Open) inside
the app, versus about 8 steps across two sites.
