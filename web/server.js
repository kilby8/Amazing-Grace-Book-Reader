// Amazing Grace Reader - backend server.
//
// Serves:
//   - /api/auth/*  (register, login, logout, me)
//   - /api/books   (list, upload, fetch file, delete)
//   - static files from this directory (index.html, styles.css, app.js, ...)
//
// Storage layout:
//   <repo>/data/library.db                       - SQLite database
//   <repo>/data/books/<user-id>/<filename>      - book files
//
// Session cookies are httpOnly + sameSite=lax, 7-day expiry. In production,
// SESSION_SECRET should be set to a random value; the dev default is fine
// for local single-user use but not for anything exposed to the internet.

const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const session = require("express-session");
const multer = require("multer");

const { getDb, closeDb } = require("./db");
const {
  createUser,
  verifyUser,
  requireAuth,
  normalizeUsername,
} = require("./auth");

const PORT = Number(process.env.PORT || 8770);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const STATIC_DIR = __dirname;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

fs.mkdirSync(BOOKS_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use(
  session({
    name: "agr.sid",
    secret:
      process.env.SESSION_SECRET ||
      "dev-only-secret-replace-in-production-AGR",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // local HTTP; flip to true behind HTTPS in prod
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ----- Multer setup: per-user destination, sanitized filename -----
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
      const base = path.basename(file.originalname || "book");
      const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "book";
      cb(null, `${Date.now()}-${safe}`);
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

// ----- Auth endpoints -----

app.post("/api/auth/register", async (req, res, next) => {
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

app.post("/api/auth/login", async (req, res, next) => {
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

app.post("/api/books", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const kind = detectKind(req.file.originalname);
  if (!kind) {
    // Clean up the orphan file we just wrote
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "Only PDF and EPUB files are supported" });
  }
  const db = getDb();
  const title = (req.body && req.body.title) || deriveTitle(req.file.originalname);
  const author = (req.body && req.body.author) || null;
  const info = db
    .prepare(
      "INSERT INTO books (user_id, title, author, kind, filename, size) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(req.session.userId, title, author, kind, req.file.filename, req.file.size);
  const book = db
    .prepare(
      "SELECT id, title, author, kind, size, added_at, last_opened_at FROM books WHERE id = ?"
    )
    .get(info.lastInsertRowid);
  res.json({ book });
});

app.get("/api/books", requireAuth, (req, res) => {
  const db = getDb();
  const books = db
    .prepare(
      "SELECT id, title, author, kind, size, added_at, last_opened_at FROM books WHERE user_id = ? ORDER BY added_at DESC"
    )
    .all(req.session.userId);
  res.json({ books });
});

app.get("/api/books/:id/file", requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
  const book = db
    .prepare("SELECT id, kind, filename FROM books WHERE id = ? AND user_id = ?")
    .get(id, req.session.userId);
  if (!book) return res.status(404).json({ error: "Not found" });
  const filePath = path.join(BOOKS_DIR, String(req.session.userId), book.filename);
  // path.join already constrains to BOOKS_DIR; double-check before sending
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(BOOKS_DIR) + path.sep) && resolved !== path.resolve(BOOKS_DIR)) {
    return res.status(400).json({ error: "Bad path" });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File missing on disk" });
  }
  db.prepare("UPDATE books SET last_opened_at = ? WHERE id = ?").run(Date.now(), book.id);
  res.setHeader("Content-Type", book.kind === "pdf" ? "application/pdf" : "application/epub+zip");
  fs.createReadStream(resolved).pipe(res);
});

app.delete("/api/books/:id", requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });
  const book = db
    .prepare("SELECT id, filename FROM books WHERE id = ? AND user_id = ?")
    .get(id, req.session.userId);
  if (!book) return res.status(404).json({ error: "Not found" });
  const filePath = path.join(BOOKS_DIR, String(req.session.userId), book.filename);
  db.prepare("DELETE FROM books WHERE id = ?").run(book.id);
  try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
  res.json({ ok: true });
});

// ----- Static files -----
// index.html is served at "/" and the API endpoints live under "/api/*".
// Multer's body parser doesn't apply to GET so this is safe.
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

const server = app.listen(PORT, HOST, () => {
  console.log(`Amazing Grace Reader listening on http://${HOST}:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
});

function shutdown(signal) {
  console.log(`\n${signal} - shutting down`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
