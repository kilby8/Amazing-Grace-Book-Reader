// Smoke test for a deployed site (Vercel + Supabase). Walks the same HTTP
// flow the browser does: sign up, upload a PDF straight to Storage, open
// it, save a reading position and a bookmark, check another user can't
// reach them, share it to the public library and save it as the other
// user, delete.
// Creates two throwaway accounts named smoke_<timestamp>_a/_b.
//
//   node test-live.mjs https://amazing-grace-reader.vercel.app
const BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node test-live.mjs <site-url>");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

function client() {
  let cookie = "";
  return async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let body = opts.body;
    if (body && typeof body === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { ...opts, headers, body });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };
}

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1"
);

const stamp = Date.now();
const a = client();
const b = client();
let r;

r = await a("/api/health");
check("health", r.status === 200 && r.json.ok && r.json.storage === "supabase", JSON.stringify(r.json));

r = await a("/api/auth/register", { method: "POST", body: { username: `smoke_${stamp}_a`, password: "password1" } });
check("register A", r.status === 200, JSON.stringify(r.json));
r = await b("/api/auth/register", { method: "POST", body: { username: `smoke_${stamp}_b`, password: "password1" } });
check("register B", r.status === 200, JSON.stringify(r.json));
r = await a("/api/me");
check("A's session sticks across requests", r.json && r.json.user && r.json.user.username === `smoke_${stamp}_a`, JSON.stringify(r.json));

r = await a("/api/books/uploads", { method: "POST", body: { filename: "smoke test.pdf", size: PDF.length } });
const target = r.json || {};
check("upload ticket", r.status === 200 && target.mode === "supabase" && target.url, JSON.stringify(r.json));

const up = await fetch(target.url, {
  method: "POST",
  headers: { ...target.headers, "Content-Type": "application/pdf" },
  body: PDF,
});
check("browser-style upload to Storage", up.ok, `${up.status} ${await up.text().catch(() => "")}`);

r = await a("/api/books/uploads/complete", { method: "POST", body: { objectPath: target.objectPath } });
const book = r.json && r.json.book;
check("complete upload", r.status === 200 && book && book.size === PDF.length, JSON.stringify(r.json));

const again = await fetch(target.url.replace(/\.pdf$/, "-2.pdf"), {
  method: "POST",
  headers: { ...target.headers, "Content-Type": "application/pdf" },
  body: PDF,
});
check("Storage rejects an upload without a ticket", !again.ok, String(again.status));

r = await b("/api/books/uploads/complete", { method: "POST", body: { objectPath: target.objectPath } });
check("B can't claim A's upload", r.status === 400, JSON.stringify(r.json));

r = await a(`/api/books/${book.id}/download`);
const dl = r.json || {};
check("download ticket", r.status === 200 && dl.url, JSON.stringify(r.json));
const file = await fetch(dl.url, { headers: dl.headers });
const bytes = Buffer.from(await file.arrayBuffer());
check("download returns the same bytes", file.ok && bytes.equals(PDF), `${file.status} ${bytes.length}`);

r = await b(`/api/books/${book.id}/download`);
check("B can't download A's private book", r.status === 404);

r = await a(`/api/books/${book.id}/progress`, { method: "POST", body: { page: 1, char_offset: 42, total_pages: 1 } });
check("save progress", r.status === 200);
r = await a("/api/books");
const listed = (r.json.books || []).find((x) => x.id === book.id);
check("library shows progress", listed && listed.progress_page === 1, JSON.stringify(listed));

r = await a(`/api/books/${book.id}/bookmarks`, { method: "POST", body: { page: 1, char_offset: 0, note: "smoke" } });
const bm = r.json && r.json.bookmark;
check("add a bookmark", r.status === 201 && bm && bm.note === "smoke", JSON.stringify(r.json));
r = await a(`/api/books/${book.id}/bookmarks/${bm && bm.id}`, { method: "PATCH", body: { note: "edited" } });
check("edit its note", r.status === 200 && r.json.bookmark.note === "edited", JSON.stringify(r.json));
r = await b(`/api/books/${book.id}/bookmarks`);
check("B can't see A's bookmarks", r.status === 404, String(r.status));
r = await a(`/api/books/${book.id}/bookmarks`);
check("bookmarks list", r.status === 200 && r.json.bookmarks.length === 1, JSON.stringify(r.json));

r = await a(`/api/books/${book.id}/visibility`, { method: "POST", body: { visibility: "public" } });
check("share publicly", r.status === 200);
r = await b(`/api/books/${book.id}/download`);
check("B can download it once public", r.status === 200 && r.json.url);

// Public library: B sees it, saves it to their shelf, removes it again
// without touching A's file.
r = await b("/api/public-books");
let pub = r.status === 200 && (r.json.books || []).find((x) => x.id === book.id);
check("public library lists it", Boolean(pub) && pub.mine === false && pub.saved === false, JSON.stringify(pub));
r = await b(`/api/public-books/${book.id}/save`, { method: "POST" });
check("B saves it to My books", r.status === 200 && r.json.saved === true, JSON.stringify(r.json));
r = await b("/api/books");
const savedRow = r.status === 200 && (r.json.books || []).find((x) => x.id === book.id);
check("it's on B's shelf, not owned", Boolean(savedRow) && savedRow.owned === false, JSON.stringify(savedRow));
r = await a("/api/public-books");
pub = (r.json.books || []).find((x) => x.id === book.id);
check("A sees it as theirs with 1 save", pub && pub.mine === true && pub.saves === 1, JSON.stringify(pub));
r = await b(`/api/books/${book.id}`, { method: "DELETE" });
check("B removing it only unsaves", r.status === 200 && r.json.unsaved === true, JSON.stringify(r.json));
r = await a(`/api/books/${book.id}/download`);
check("A's file is untouched", r.status === 200 && r.json.url);

r = await a(`/api/books/${book.id}`, { method: "DELETE" });
check("delete", r.status === 200);
r = await a(`/api/books/${book.id}/download`);
check("deleted book is gone from the library", r.status === 404, String(r.status));
// Storage's CDN may still hold the earlier response for this exact URL, so
// ask with a query string it hasn't seen.
const gone = await fetch(`${dl.url}?after_delete=${Date.now()}`, { headers: dl.headers });
check("file removed from Storage", !gone.ok, String(gone.status));

r = await a("/api/auth/logout", { method: "POST" });
r = await a("/api/me");
check("logout", r.json && r.json.user === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
