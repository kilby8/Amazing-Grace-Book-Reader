// Amazing Grace Reader - backend server.
//
// Serves:
//   - /api/auth/*  (register, login, logout, me)
//   - /api/books   (list, upload, download, delete, reading progress)
//   - /api/tts     (ElevenLabs proxy - keeps API key off the wire)
//   - /api/health  (database reachability, for deploy checks)
//   - static files from ./public (index.html, styles.css, app.js)
//
// Storage (see db.js and storage.js):
//   local:  <repo>/data/library.db (SQLite) + <repo>/data/books/<user-id>/
//   hosted: Postgres via DATABASE_URL + Supabase Storage via SUPABASE_URL
//
// Runs as a normal server (`node server.js`) or as a serverless function:
// api/index.js re-exports the app for Vercel.
//
// Session cookies are httpOnly + sameSite=lax, 7-day expiry. Sessions are
// stored in the database so logins survive restarts. In production,
// SESSION_SECRET should be set to a random value; the dev default is fine
// for local single-user use but not for anything exposed to the internet.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { query, queryOne, closeDb } = require("./db");
const { DbSessionStore } = require("./session-store");
const storage = require("./storage");
const { createFinder } = require("./finder");
const {
  createUser,
  verifyUser,
  requireAuth,
  normalizeUsername,
} = require("./auth");

const PORT = Number(process.env.PORT || 8770);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET;
const POCKET_ORIGIN = process.env.POCKET_ORIGIN || "https://gracereader.duckdns.org";
if (IS_PROD && !SESSION_SECRET) {
  console.error("FATAL: SESSION_SECRET is required in production. Refusing to start.");
  process.exit(1);
}
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const STATIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

// ElevenLabs: read the API key at request time from the credentials file
// (overridable via ELEVENLABS_API_KEY env var). The key never leaves the
// server - the browser only sees /api/tts, which requires an auth session.
const ELEVENLABS_KEY_FILE =
  process.env.ELEVENLABS_KEY_FILE ||
  path.join(os.homedir(), ".mavis", "elevenlabs_credentials.json");
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
// Free tier compatible model - monolingual_v1 / multilingual_v1 are 402.
const ELEVENLABS_DEFAULT_MODEL = "eleven_turbo_v2_5";
const ELEVENLABS_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah
// Per-request text cap. Free tier is 10k chars/month - cap so a runaway
// reader can't drain the quota in one chunk.
const ELEVENLABS_MAX_CHARS = 1500;

function loadElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    let raw = fs.readFileSync(ELEVENLABS_KEY_FILE, "utf8");
    // PowerShell's Set-Content -Encoding UTF8 writes a BOM; JSON.parse
    // rejects it. Strip if present.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return j.api_key || null;
  } catch (_) {
    return null;
  }
}

if (storage.MODE === "local") fs.mkdirSync(BOOKS_DIR, { recursive: true });

// Express 4 doesn't route rejected promises to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.disable("x-powered-by");
// Trust the first proxy hop (Caddy, or Vercel's edge) when behind HTTPS;
// required for express-rate-limit to see the real client IP and for secure
// cookies to flow correctly.
if (IS_PROD) app.set("trust proxy", 1);
// Security headers (CSP allows the CDN scripts + Google Fonts + style
// inline attributes the reader UI relies on). Loopback hosts are
// permitted in connect-src so the pocket-tts engine (which lives at
// 127.0.0.1:8765 on the reader's own box) can be reached, as is the hosted
// Pocket server the UI points at by default (POCKET_ORIGIN overrides it);
// the Supabase origin is permitted when books live in Supabase Storage.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
        ],
        styleSrc: [
          "'self'",
          "https://fonts.googleapis.com",
          "'unsafe-inline'",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        // Book finder covers come from the sources themselves.
        imgSrc: ["'self'", "data:", "blob:", "https://www.gutenberg.org", "https://archive.org", "https://*.archive.org"],
        connectSrc: [
          "'self'",
          "http://127.0.0.1:*",
          "http://localhost:*",
          POCKET_ORIGIN,
          ...(storage.MODE === "supabase" ? [storage.SUPABASE_URL] : []),
        ],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        frameSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: "64kb" }));

const sessionStore = new DbSessionStore();
app.use(
  session({
    name: "agr.sid",
    store: sessionStore,
    secret: SESSION_SECRET || "dev-only-secret-replace-in-production-AGR",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD, // true in prod (HTTPS only), false in dev
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Rate limit: 30 req / 15 min per IP on auth endpoints. Generous enough
// for normal use, hostile enough to stop credential stuffing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});
// TTS proxy is the most expensive endpoint - cap per-user rate at 60/min
// (≈ one short chapter of chunks per minute sustained).
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "TTS rate limit hit, slow down." },
});

// Book finder: searches are cheap but hit outside services; adds download
// a whole book, so they get a tighter cap.
const finderSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many searches, slow down." },
});
const finderAddLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many books at once, try again in a minute." },
});

// ----- Multer setup (local storage only): per-user destination, sanitized filename -----
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const userDir = path.join(BOOKS_DIR, String(req.session.userId));
      fs.mkdirSync(userDir, { recursive: true });
      cb(null, userDir);
    },
    filename(req, file, cb) {
      // Strip path separators and shell-unsafe chars from the original
      // filename. Prepend a timestamp to avoid collisions.
      cb(null, `${Date.now()}-${storage.safeFilename(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function detectKind(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  return null;
}

function deriveTitle(originalName) {
  const base = path.basename(originalName || "Untitled", path.extname(originalName || ""));
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function bookId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Bad id" });
    return null;
  }
  return id;
}

// ----- Health -----

app.get("/api/health", wrap(async (req, res) => {
  try {
    await query("SELECT 1 AS ok");
    res.json({ ok: true, storage: storage.MODE });
  } catch (e) {
    console.error("health check failed:", e);
    res.status(503).json({ ok: false, error: "database unreachable" });
  }
}));

// ----- Auth endpoints -----

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await createUser(username, password);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) return next(err);
      res.json({ user });
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Could not register" });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await verifyUser(username, password);
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) return next(err);
      res.json({ user });
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("agr.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      user: {
        id: req.session.userId,
        username: req.session.username,
      },
    });
  } else {
    res.json({ user: null });
  }
});

// ----- Books endpoints -----

const BOOK_COLUMNS = "id, title, author, kind, size, added_at, last_opened_at, visibility, shared_at";

async function insertBook(userId, { title, author, kind, filename, size }) {
  return queryOne(
    `INSERT INTO books (user_id, title, author, kind, filename, size)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING ${BOOK_COLUMNS}`,
    [userId, title, author, kind, filename, size]
  );
}

// Upload, local storage: the file comes through this server.
app.post("/api/books", requireAuth, (req, res, next) => {
  if (storage.MODE !== "local") {
    return res.status(400).json({ error: "Upload with /api/books/uploads on this server" });
  }
  next();
}, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const kind = detectKind(req.file.originalname);
  if (!kind) {
    // Clean up the orphan file we just wrote
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "Only PDF and EPUB files are supported" });
  }
  const book = await insertBook(req.session.userId, {
    title: (req.body && req.body.title) || deriveTitle(req.file.originalname),
    author: (req.body && req.body.author) || null,
    kind,
    filename: req.file.filename,
    size: req.file.size,
  });
  res.json({ book });
}));

// Upload, step 1: ask where to put the file. Local storage answers
// {mode:"local"} (POST the file to /api/books); Supabase Storage answers
// with a URL and headers the browser uploads to directly.
app.post("/api/books/uploads", requireAuth, wrap(async (req, res) => {
  if (storage.MODE === "local") return res.json({ mode: "local" });
  const { filename, size } = req.body || {};
  const kind = detectKind(filename);
  if (!kind) return res.status(400).json({ error: "Only PDF and EPUB files are supported" });
  const target = await storage.createUpload(req.session.userId, filename);
  if (Number(size) > target.maxBytes) {
    return res.status(413).json({ error: `File too large (${Math.round(target.maxBytes / 1048576)} MB max)` });
  }
  // Remember what this session is uploading so step 2 can't claim
  // someone else's object.
  req.session.pendingUploads = {
    ...(req.session.pendingUploads || {}),
    [target.objectPath]: { filename: String(filename), kind },
  };
  res.json({ mode: "supabase", objectPath: target.objectPath, url: target.url, headers: target.headers });
}));

// Upload, step 2 (Supabase Storage): the browser finished uploading.
app.post("/api/books/uploads/complete", requireAuth, wrap(async (req, res) => {
  const { objectPath, title, author } = req.body || {};
  const pendingUploads = req.session.pendingUploads || {};
  const pending = Object.hasOwn(pendingUploads, String(objectPath)) ? pendingUploads[objectPath] : null;
  if (!pending) return res.status(400).json({ error: "Unknown upload" });
  const size = await storage.uploadedSize(objectPath);
  if (size === null) return res.status(400).json({ error: "Upload not found in storage" });
  await storage.finishUpload(objectPath);
  delete req.session.pendingUploads[objectPath];
  const book = await insertBook(req.session.userId, {
    title: title || deriveTitle(pending.filename),
    author: author || null,
    kind: pending.kind,
    filename: objectPath,
    size,
  });
  res.json({ book });
}));

app.get("/api/books", requireAuth, wrap(async (req, res) => {
  const books = await query(
    `SELECT b.id, b.title, b.author, b.kind, b.size, b.added_at, b.last_opened_at,
            b.visibility, b.shared_at,
            p.page AS progress_page, p.total_pages AS progress_total_pages
     FROM books b
     LEFT JOIN reading_progress p ON p.book_id = b.id AND p.user_id = b.user_id
     WHERE b.user_id = ?
     ORDER BY b.added_at DESC`,
    [req.session.userId]
  );
  res.json({ books });
}));

// ----- Public library -----
// Authenticated users only. Lists every book marked public across all users,
// joined with the uploader's username so the UI can show "Shared by @...".
// Sorted by shared_at DESC so the most recent shares surface first.
app.get("/api/public-books", requireAuth, wrap(async (req, res) => {
  const books = await query(
    `SELECT b.id, b.title, b.author, b.kind, b.size, b.shared_at,
            u.username AS shared_by
     FROM books b
     JOIN users u ON u.id = b.user_id
     WHERE b.visibility = 'public'
     ORDER BY b.shared_at DESC, b.id DESC`
  );
  res.json({ books });
}));

// Toggle a book's visibility. Owner-only; idempotent.
app.post("/api/books/:id/visibility", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  const visibility = req.body && req.body.visibility;
  if (visibility !== "private" && visibility !== "public") {
    return res.status(400).json({ error: "visibility must be 'private' or 'public'" });
  }
  const book = await queryOne("SELECT id, user_id FROM books WHERE id = ?", [id]);
  if (!book) return res.status(404).json({ error: "Not found" });
  if (book.user_id !== req.session.userId) {
    return res.status(403).json({ error: "Not your book" });
  }
  // shared_at is set when promoting to public, cleared when demoting.
  const sharedAt = visibility === "public" ? Date.now() : null;
  await query("UPDATE books SET visibility = ?, shared_at = ? WHERE id = ?", [visibility, sharedAt, id]);
  res.json({ ok: true, visibility, shared_at: sharedAt });
}));

// A book the caller may open: their own, or a public one. Owner check is
// conditional, and a private book of someone else's looks like a 404.
async function readableBook(id, userId) {
  const book = await queryOne(
    "SELECT id, user_id, kind, filename, visibility FROM books WHERE id = ?",
    [id]
  );
  if (!book) return null;
  if (book.user_id !== userId && book.visibility !== "public") return null;
  return book;
}

// Only the owner's own reads count as "last opened" - opening a public
// book shouldn't update the owner's library state.
async function markOpened(book, userId) {
  if (book.user_id === userId) {
    await query("UPDATE books SET last_opened_at = ? WHERE id = ?", [Date.now(), book.id]);
  }
}

// Where the browser fetches the book file from: this server (local
// storage) or a short-lived Supabase Storage URL.
app.get("/api/books/:id/download", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  const book = await readableBook(id, req.session.userId);
  if (!book) return res.status(404).json({ error: "Not found" });
  await markOpened(book, req.session.userId);
  if (storage.MODE === "local") {
    return res.json({ url: `/api/books/${id}/file`, headers: {} });
  }
  res.json(await storage.createDownload(book.filename));
}));

app.get("/api/books/:id/file", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  if (storage.MODE !== "local") return res.status(404).json({ error: "Use /api/books/:id/download" });
  const book = await readableBook(id, req.session.userId);
  if (!book) return res.status(404).json({ error: "Not found" });
  // Path is always scoped to the OWNER's directory (files never move when shared).
  const filePath = path.join(BOOKS_DIR, String(book.user_id), book.filename);
  // path.join already constrains to BOOKS_DIR; double-check before sending
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(BOOKS_DIR) + path.sep) && resolved !== path.resolve(BOOKS_DIR)) {
    return res.status(400).json({ error: "Bad path" });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File missing on disk" });
  }
  await markOpened(book, req.session.userId);
  res.setHeader("Content-Type", book.kind === "pdf" ? "application/pdf" : "application/epub+zip");
  fs.createReadStream(resolved).pipe(res);
}));

// ----- Book finder -----
// Search free, legal sources (Project Gutenberg, Internet Archive) and add a
// result to the library. The server downloads the file itself: the browser
// only names a result id, and serverless hosts cap bodies at 4.5 MB anyway.
// See FINDER.md.
const finder = createFinder({ maxBytes: 50 * 1024 * 1024 });

app.get("/api/finder/search", requireAuth, finderSearchLimiter, wrap(async (req, res) => {
  const q = String(req.query.q || "");
  if (q.trim().length < 2) return res.status(400).json({ error: "Type at least 2 letters" });
  res.json(await finder.search(q));
}));

app.post("/api/finder/add", requireAuth, finderAddLimiter, wrap(async (req, res) => {
  const { id, title, author } = req.body || {};
  let file;
  try {
    file = await finder.download(String(id || ""));
  } catch (e) {
    const status = e.status || (e.name === "TimeoutError" ? 504 : 502);
    const msg = e.name === "TimeoutError" ? "The book took too long to download, try again"
      : e.name === "TypeError" ? "Couldn't reach the library that has this book, try again in a moment"
      : e.message;
    return res.status(status).json({ error: msg });
  }
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
  const cleanAuthor = String(author || "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const name = `${cleanTitle}.${file.kind}`;
  let filename;
  if (storage.MODE === "local") {
    const userDir = path.join(BOOKS_DIR, String(req.session.userId));
    fs.mkdirSync(userDir, { recursive: true });
    filename = `${Date.now()}-${storage.safeFilename(name)}`;
    fs.writeFileSync(path.join(userDir, filename), file.buffer);
  } else {
    const type = file.kind === "pdf" ? "application/pdf" : "application/epub+zip";
    filename = await storage.putObject(req.session.userId, name, file.buffer, type);
  }
  const book = await insertBook(req.session.userId, {
    title: cleanTitle,
    author: cleanAuthor,
    kind: file.kind,
    filename,
    size: file.buffer.length,
  });
  res.json({ book });
}));

// ----- Reading progress -----
// Each reader keeps their own place in a book. Readable for any book the
// caller can open (their own, or a public one); same 404 as /file otherwise.

app.get("/api/books/:id/progress", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  if (!(await readableBook(id, req.session.userId))) return res.status(404).json({ error: "Not found" });
  const progress = await queryOne(
    "SELECT page, char_offset, total_pages, updated_at FROM reading_progress WHERE user_id = ? AND book_id = ?",
    [req.session.userId, id]
  );
  res.json({ progress });
}));

// POST (not PUT) so the reader can save with navigator.sendBeacon when the
// tab closes.
app.post("/api/books/:id/progress", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  if (!(await readableBook(id, req.session.userId))) return res.status(404).json({ error: "Not found" });
  const { page, char_offset, total_pages } = req.body || {};
  const p = Number(page);
  const off = Number(char_offset || 0);
  const total = total_pages == null ? null : Number(total_pages);
  if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: "page must be a positive integer" });
  if (!Number.isInteger(off) || off < 0) return res.status(400).json({ error: "char_offset must be a non-negative integer" });
  if (total !== null && (!Number.isInteger(total) || total < 1)) {
    return res.status(400).json({ error: "total_pages must be a positive integer" });
  }
  const now = Date.now();
  await query(
    `INSERT INTO reading_progress (user_id, book_id, page, char_offset, total_pages, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET
       page = excluded.page, char_offset = excluded.char_offset,
       total_pages = COALESCE(excluded.total_pages, reading_progress.total_pages),
       updated_at = excluded.updated_at`,
    [req.session.userId, id, p, off, total, now]
  );
  res.json({ ok: true, updated_at: now });
}));

// ----- Bookmarks -----
// Per reader, like progress: anyone who can open the book keeps their own.

const BOOKMARK_NOTE_MAX = 500;
const BOOKMARKS_PER_BOOK_MAX = 500;

app.get("/api/books/:id/bookmarks", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  if (!(await readableBook(id, req.session.userId))) return res.status(404).json({ error: "Not found" });
  const bookmarks = await query(
    "SELECT id, page, char_offset, note, created_at FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY page, char_offset, id",
    [req.session.userId, id]
  );
  res.json({ bookmarks });
}));

app.post("/api/books/:id/bookmarks", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  if (!(await readableBook(id, req.session.userId))) return res.status(404).json({ error: "Not found" });
  const { page, char_offset, note } = req.body || {};
  const p = Number(page);
  const off = Number(char_offset || 0);
  if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: "page must be a positive integer" });
  if (!Number.isInteger(off) || off < 0) return res.status(400).json({ error: "char_offset must be a non-negative integer" });
  if (note != null && typeof note !== "string") return res.status(400).json({ error: "note must be text" });
  const text = note ? note.trim().slice(0, BOOKMARK_NOTE_MAX) : null;
  const count = await queryOne(
    "SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND book_id = ?",
    [req.session.userId, id]
  );
  if (Number(count.n) >= BOOKMARKS_PER_BOOK_MAX) return res.status(400).json({ error: "Too many bookmarks in this book" });
  const bookmark = await queryOne(
    `INSERT INTO bookmarks (user_id, book_id, page, char_offset, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, page, char_offset, note, created_at`,
    [req.session.userId, id, p, off, text || null, Date.now()]
  );
  res.status(201).json({ bookmark });
}));

app.patch("/api/books/:id/bookmarks/:bookmarkId", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  const bid = Number(req.params.bookmarkId);
  if (!Number.isInteger(bid) || bid < 1) return res.status(400).json({ error: "Invalid bookmark id" });
  const { note } = req.body || {};
  if (note != null && typeof note !== "string") return res.status(400).json({ error: "note must be text" });
  const text = note ? note.trim().slice(0, BOOKMARK_NOTE_MAX) : "";
  const bookmark = await queryOne(
    `UPDATE bookmarks SET note = ? WHERE id = ? AND book_id = ? AND user_id = ?
     RETURNING id, page, char_offset, note, created_at`,
    [text || null, bid, id, req.session.userId]
  );
  if (!bookmark) return res.status(404).json({ error: "Not found" });
  res.json({ bookmark });
}));

app.delete("/api/books/:id/bookmarks/:bookmarkId", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  const bid = Number(req.params.bookmarkId);
  if (!Number.isInteger(bid) || bid < 1) return res.status(400).json({ error: "Invalid bookmark id" });
  const gone = await query(
    "DELETE FROM bookmarks WHERE id = ? AND book_id = ? AND user_id = ? RETURNING id",
    [bid, id, req.session.userId]
  );
  if (gone.length === 0) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

// ----- ElevenLabs TTS proxy -----
//
// Body: { text, voice_id?, model_id? }
// Returns: audio/mpeg stream from ElevenLabs (mp3).
// The ElevenLabs API key is read from ELEVENLABS_API_KEY env var or
// ~/.mavis/elevenlabs_credentials.json and never sent to the browser.

app.post("/api/tts", requireAuth, ttsLimiter, async (req, res, next) => {
  try {
    const apiKey = loadElevenLabsKey();
    if (!apiKey) {
      return res.status(503).json({
        error:
          "ElevenLabs is not configured. Set ELEVENLABS_API_KEY or add api_key to ~/.mavis/elevenlabs_credentials.json.",
      });
    }
    const { text, voice_id, model_id } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    if (text.length > ELEVENLABS_MAX_CHARS) {
      return res.status(400).json({
        error: `text too long (max ${ELEVENLABS_MAX_CHARS} chars per request)`,
      });
    }
    const voiceId = voice_id || ELEVENLABS_DEFAULT_VOICE;
    const modelId = model_id || ELEVENLABS_DEFAULT_MODEL;
    const url = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => "");
      // ElevenLabs returns a JSON body with detail.code; peek at it so we
      // can distinguish "invalid_api_key" from "quota_exceeded" - they
      // both come back as HTTP 401, but the meaning is very different.
      let errCode = null;
      try {
        errCode = JSON.parse(errBody)?.detail?.code || null;
      } catch (_) { /* non-JSON or empty */ }
      console.error(
        `ElevenLabs error ${upstream.status} (${errCode || "?"}): ${errBody.slice(0, 200)}`
      );
      if (upstream.status === 401 && errCode === "quota_exceeded") {
        return res.status(503).json({
          error: "ElevenLabs: free-tier quota exhausted. Switch to a different TTS engine or upgrade your plan.",
          code: "quota_exceeded",
        });
      }
      if (upstream.status === 401) {
        return res.status(502).json({ error: "ElevenLabs: invalid API key" });
      }
      if (upstream.status === 402) {
        return res.status(503).json({
          error: "ElevenLabs: quota exhausted or model unavailable",
          code: "quota_exceeded",
        });
      }
      if (upstream.status === 429) {
        return res
          .status(502)
          .json({ error: "ElevenLabs: rate limited, try again shortly" });
      }
      return res
        .status(502)
        .json({ error: `ElevenLabs upstream error (${upstream.status})` });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // Stream the upstream response through to the browser.
    const reader = upstream.body.getReader();
    res.on("close", () => {
      try { reader.cancel(); } catch (_) {}
    });
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        // Backpressure: wait for drain before pulling the next chunk.
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (e) {
    next(e);
  }
});

app.delete("/api/books/:id", requireAuth, wrap(async (req, res) => {
  const id = bookId(req, res);
  if (id === null) return;
  const book = await queryOne(
    "SELECT id, filename FROM books WHERE id = ? AND user_id = ?",
    [id, req.session.userId]
  );
  if (!book) return res.status(404).json({ error: "Not found" });
  await query("DELETE FROM books WHERE id = ?", [book.id]);
  if (storage.MODE === "local") {
    const filePath = path.join(BOOKS_DIR, String(req.session.userId), book.filename);
    try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
  } else {
    await storage.remove(book.filename);
  }
  res.json({ ok: true });
}));

// ----- Static files -----
// index.html is served at "/" and the API endpoints live under "/api/*".
app.use(express.static(STATIC_DIR, { index: "index.html" }));

// 404 for unknown API routes
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large (200 MB max)" });
  }
  res.status(500).json({ error: "Server error" });
});

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Amazing Grace Reader listening on http://${HOST}:${PORT}`);
    console.log(`  database: ${process.env.DATABASE_URL ? "postgres" : "sqlite"} · storage: ${storage.MODE}`);
    if (storage.MODE === "local") console.log(`  data dir: ${DATA_DIR}`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} - shutting down`);
    server.close(async () => {
      sessionStore.close();
      await closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
