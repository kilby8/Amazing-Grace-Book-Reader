// SQLite schema and helpers for the Amazing Grace Reader library.
//
// Uses Node's built-in `node:sqlite` (Node >= 22.5 with --experimental-sqlite
// flag, or built-in in Node 24+). No native compilation needed - this
// avoids the better-sqlite3 / VS build-toolchain headache.
//
// Database file lives outside the web/ folder so the static handler (and
// the git repo) never serves the binary db. The location is data/library.db
// at the repo root, overridable via DB_PATH for tests.
//
// Tables:
//   users:  id, username (unique), password_hash (bcrypt), created_at
//   books:  id, user_id (fk), title, author, kind ('pdf'|'epub'),
//           filename (on disk, sanitized), size, added_at, last_opened_at,
//           visibility ('private'|'public'), shared_at (ms; null while private)
//
// Per-user isolation: every book query is scoped by user_id. The requireAuth
// middleware ensures the session is present; controllers additionally filter
// by user_id on the WHERE clause so a session for one user can never see
// another user's books even if the URL is guessed.

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_DIR = path.join(__dirname, "..", "data");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "library.db");

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  // WAL for better concurrent reads; foreign keys for the ON DELETE CASCADE
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE IF NOT EXISTS books (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      author          TEXT,
      kind            TEXT NOT NULL CHECK (kind IN ('pdf','epub')),
      filename        TEXT NOT NULL,
      size            INTEGER NOT NULL,
      added_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      last_opened_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS books_user_id_idx ON books(user_id);
  `);
  // ----- Migrations -----
  // Idempotent: skip columns that already exist so re-running getDb() is safe.
  const bookCols = new Set(_db.prepare("PRAGMA table_info(books)").all().map((c) => c.name));
  if (!bookCols.has("visibility")) {
    _db.exec(
      "ALTER TABLE books ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public'))"
    );
  }
  if (!bookCols.has("shared_at")) {
    _db.exec("ALTER TABLE books ADD COLUMN shared_at INTEGER");
  }
  // Partial index for the public feed (only rows where it matters).
  _db.exec(
    "CREATE INDEX IF NOT EXISTS books_public_shared_idx ON books(visibility, shared_at DESC) WHERE visibility = 'public'"
  );
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb };
